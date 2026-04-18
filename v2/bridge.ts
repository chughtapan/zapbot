/**
 * v2/bridge — thinned HTTP bridge.
 *
 * Responsibilities (only):
 *   - Boot HTTP server on configured port.
 *   - Register/deregister with gateway; periodic heartbeat.
 *   - Verify HMAC + classify webhook → dispatch.
 *   - SIGHUP reload + graceful shutdown.
 *
 * Everything v1 had beyond this list is deleted (state machine, SQLite,
 * plannotator, workflow/agent HTTP APIs, progress poller, cleanup sweep).
 */

import { verifyAndClassify, registerBridge, deregisterBridge, startHeartbeat } from "./gateway.ts";
import type { GatewayClientConfig, GatewayWebhookEnvelope, ClassifiedWebhook } from "./gateway.ts";
import { dispatch } from "./ao/dispatcher.ts";
import { getIssue } from "./github-state.ts";
import {
  absurd,
  asAoSessionName,
  asDeliveryId,
  asRepoFullName,
  err,
  ok,
} from "./types.ts";
import type {
  BotUsername,
  DispatchError,
  GhCallError,
  HandleOutcome,
  InstallationToken,
  IssueNumber,
  ProjectName,
  RepoFullName,
  Result,
} from "./types.ts";
import { createGitHubClient, getInstallationToken } from "../src/github/client.ts";
import { createLogger } from "../src/logger.ts";
import { errorResponse } from "../src/http/error-response.ts";
import {
  handleInstallationTokenRequest,
  type InstallationTokenStatus,
} from "../src/http/routes/installation-token.ts";

const WRITE_PERMISSIONS = new Set(["write", "maintain", "admin"]);
const log = createLogger("v2/bridge");

// ── Typed wrapper around v1 gh.* (which throws) ─────────────────────

/**
 * Call an async function from the v1 GitHub client and map thrown errors into
 * a typed `GhCallError`. The bridge never re-throws across a module boundary.
 * Failures are logged at `warn` so silent catches do not hide regressions.
 */
async function safeGh<T>(
  label: string,
  fn: () => Promise<T>
): Promise<Result<T, GhCallError>> {
  try {
    return ok(await fn());
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    log.warn(`gh_call_failed label=${label} cause=${cause}`);
    return err({ _tag: "GhCallFailed", label, cause });
  }
}

// ── Boot config ─────────────────────────────────────────────────────

export interface BridgeConfig {
  readonly port: number;
  readonly publicUrl: string;
  readonly gatewayUrl: string;
  readonly gatewaySecret: string | null;
  readonly botUsername: BotUsername;
  readonly aoConfigPath: string;
  readonly apiKey: string;
  readonly repos: ReadonlyMap<RepoFullName, RepoRoute>;
}

export interface RepoRoute {
  readonly projectName: ProjectName;
  readonly webhookSecretEnvVar: string;
  readonly defaultBranch: string;
}

// ── Lifecycle ───────────────────────────────────────────────────────

export interface RunningBridge {
  readonly stop: () => Promise<void>;
  readonly reload: (nextConfig: BridgeConfig) => Promise<void>;
}

export interface BridgeHandlerContext {
  readonly mintToken: () => Promise<Result<InstallationToken, DispatchError>>;
  readonly gh: GhAdapter;
  readonly config: BridgeConfig;
}

export interface GhAdapter {
  readonly addReaction: (repo: RepoFullName, commentId: number, reaction: string) => Promise<Result<void, GhCallError>>;
  readonly getUserPermission: (repo: RepoFullName, user: string) => Promise<Result<string, GhCallError>>;
  readonly postComment: (repo: RepoFullName, issue: IssueNumber, body: string) => Promise<Result<void, GhCallError>>;
}

export type { HandleOutcome } from "./types.ts";

// ── Handler ─────────────────────────────────────────────────────────

/**
 * Dispatch a classified webhook. Pure over the handler context; no access
 * to server globals. Returns an outcome or a `DispatchError`.
 */
export async function handleClassifiedWebhook(
  classified: ClassifiedWebhook,
  ctx: BridgeHandlerContext
): Promise<Result<HandleOutcome, DispatchError>> {
  if (classified.kind === "ignore") {
    return { _tag: "Ok", value: { kind: "ignored", reason: classified.reason } };
  }
  if (classified.kind === "mention_command") {
    return handleMention(classified, ctx);
  }
  return absurd(classified);
}

async function handleMention(
  c: Extract<ClassifiedWebhook, { kind: "mention_command" }>,
  ctx: BridgeHandlerContext
): Promise<Result<HandleOutcome, DispatchError>> {
  // Eyes reaction for immediate UX feedback (best-effort; log on failure, never bubble).
  void ctx.gh.addReaction(c.repo, c.commentId as unknown as number, "eyes");

  const permResult = await ctx.gh.getUserPermission(c.repo, c.triggeredBy);
  if (permResult._tag === "Err") {
    void ctx.gh.postComment(
      c.repo,
      c.issue,
      `Sorry @${c.triggeredBy}, I couldn't verify your permissions right now. Please try again in a moment.`
    );
    return ok({ kind: "unauthorized", actor: c.triggeredBy, reason: "permission_check_failed" });
  }
  if (!WRITE_PERMISSIONS.has(permResult.value)) {
    void ctx.gh.postComment(
      c.repo,
      c.issue,
      `Sorry @${c.triggeredBy}, you need write access to this repo to use commands.`
    );
    return ok({ kind: "unauthorized", actor: c.triggeredBy, reason: "insufficient_permission" });
  }

  const cmd = c.command;
  switch (cmd.kind) {
    case "plan_this":
    case "investigate_this": {
      const route = ctx.config.repos.get(c.repo);
      if (route === undefined) {
        return err({ _tag: "ProjectNotConfigured", repo: c.repo });
      }
      const tokenResult = await ctx.mintToken();
      if (tokenResult._tag === "Err") return tokenResult;
      const dispatched = await dispatch({
        repo: c.repo,
        issue: c.issue,
        projectName: route.projectName,
        configPath: ctx.config.aoConfigPath,
        installationToken: tokenResult.value,
      });
      if (dispatched._tag === "Err") return dispatched;
      const session = asAoSessionName(dispatched.value as unknown as string);
      void ctx.gh.postComment(
        c.repo,
        c.issue,
        `Dispatching agent for @${c.triggeredBy}. Session: \`${session as unknown as string}\`.`
      );
      return ok({ kind: "dispatched", repo: c.repo, session });
    }
    case "status": {
      const summary = await summarizeIssue(c.repo, c.issue);
      void ctx.gh.postComment(c.repo, c.issue, summary);
      return ok({ kind: "replied", command: "status" });
    }
    case "unknown_command": {
      void ctx.gh.postComment(
        c.repo,
        c.issue,
        `@${c.triggeredBy} I don't recognize the command \`${cmd.raw}\`. Try \`plan this\`, \`investigate this\`, or \`status\`.`
      );
      return ok({ kind: "replied", command: "unknown_command" });
    }
    default:
      return absurd(cmd);
  }
}

async function summarizeIssue(repo: RepoFullName, issue: IssueNumber): Promise<string> {
  const snap = await getIssue(repo, issue);
  if (snap._tag === "Err") {
    return `Could not fetch issue state (${snap.error._tag}).`;
  }
  const { state, labels, assignees } = snap.value;
  const lines = [
    `**Status for #${issue as unknown as number}**`,
    `State: \`${state}\`; labels: ${labels.length ? labels.map((l) => `\`${l}\``).join(", ") : "_(none)_"}`,
    `Assignees: ${assignees.length ? assignees.map((a) => `@${a}`).join(", ") : "_(none)_"}`,
  ];
  return lines.join("\n");
}

// ── Server boot ─────────────────────────────────────────────────────

/**
 * Build the default `GhAdapter` that wraps v1 `createGitHubClient()` with
 * `safeGh`. Tests substitute their own adapter via `BridgeHandlerContext`.
 */
export function buildDefaultGhAdapter(): GhAdapter {
  const gh = createGitHubClient();
  return {
    addReaction: (repo, commentId, reaction) =>
      safeGh("addReaction", () => gh.addReaction(repo as unknown as string, commentId, reaction)),
    getUserPermission: (repo, user) =>
      safeGh("getUserPermission", () => gh.getUserPermission(repo as unknown as string, user)),
    postComment: (repo, issue, body) =>
      safeGh("postComment", async () => {
        await gh.postComment(repo as unknown as string, issue as unknown as number, body);
      }),
  };
}

/**
 * Default `mintToken` implementation — delegates to the v1 singleton
 * `getInstallationToken` and maps `null`/throw into `DispatchError`.
 */
export async function defaultMintToken(): Promise<Result<InstallationToken, DispatchError>> {
  try {
    const t = await getInstallationToken();
    if (!t) return err({ _tag: "TokenMintFailed", cause: "no installation token available" });
    return ok(t as unknown as InstallationToken);
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    return err({ _tag: "TokenMintFailed", cause });
  }
}

/**
 * Boot the HTTP server, register every configured repo with the gateway,
 * start heartbeats, install SIGHUP → reload. Returns a handle for stop/reload.
 */
export async function startBridge(config: BridgeConfig): Promise<RunningBridge> {
  let current = config;
  let stopHeartbeat: (() => void) | null = null;

  async function registerAll(cfg: BridgeConfig): Promise<void> {
    const repos = Array.from(cfg.repos.keys());
    if (repos.length === 0) return;
    const client: GatewayClientConfig = {
      gatewayUrl: cfg.gatewayUrl,
      secret: cfg.gatewaySecret,
      token: null,
    };
    await Promise.allSettled(
      repos.map((repo) => registerBridge(client, repo, cfg.publicUrl))
    );
    if (stopHeartbeat) stopHeartbeat();
    const intervalMs = parseInt(process.env.ZAPBOT_GATEWAY_HEARTBEAT_MS ?? "300000", 10);
    stopHeartbeat = startHeartbeat(client, repos, cfg.publicUrl, intervalMs);
  }

  async function deregisterAll(cfg: BridgeConfig): Promise<void> {
    const repos = Array.from(cfg.repos.keys());
    const client: GatewayClientConfig = {
      gatewayUrl: cfg.gatewayUrl,
      secret: cfg.gatewaySecret,
      token: null,
    };
    await Promise.allSettled(
      repos.map((repo) => deregisterBridge(client, repo, cfg.publicUrl))
    );
  }

  const ghAdapter = buildDefaultGhAdapter();
  const ctx: BridgeHandlerContext = {
    mintToken: defaultMintToken,
    gh: ghAdapter,
    get config() {
      return current;
    },
  };

  const server = Bun.serve({
    port: current.port,
    async fetch(req) {
      const url = new URL(req.url);
      const pathname = url.pathname;

      if (pathname === "/healthz") {
        return new Response("ok", { status: 200 });
      }

      // Installation token broker (paired with safer-by-default#50).
      // Thin wrapper around getInstallationToken() — no new mint path.
      if (pathname === "/api/tokens/installation" && req.method === "GET") {
        const result: InstallationTokenStatus = await handleInstallationTokenRequest(req, {
          mintToken: getInstallationToken,
          apiKey: current.apiKey,
          now: () => new Date(),
        });
        const clientIp = req.headers.get("x-forwarded-for") ?? "local";
        log.info(`installation_token.request status=${result.status} client_ip=${clientIp}`);
        return Response.json(result.body, { status: result.status });
      }

      if (pathname === "/api/webhooks/github" && req.method === "POST") {
        const body = await req.text();
        const signature = req.headers.get("x-hub-signature-256");
        const eventType = req.headers.get("x-github-event") ?? "";
        const deliveryId = req.headers.get("x-github-delivery") ?? "";

        let payload: unknown;
        try {
          payload = JSON.parse(body);
        } catch {
          return errorResponse(400, "invalid_request", "Request body is not valid JSON.");
        }

        const repoName = (payload as { repository?: { full_name?: string } })?.repository?.full_name ?? "";
        const repo = asRepoFullName(repoName);

        if (current.repos.size > 0 && repoName && !current.repos.has(repo)) {
          return errorResponse(403, "configuration_error", `Repo '${repoName}' is not configured on this bridge.`);
        }

        const envelope: GatewayWebhookEnvelope = {
          rawBody: body,
          signature,
          eventType,
          deliveryId: asDeliveryId(deliveryId),
          repo,
          payload,
        };

        const classified = await verifyAndClassify(
          envelope,
          (r) => resolveSecret(r, current),
          current.botUsername
        );

        if (classified._tag === "Err") {
          const e = classified.error;
          switch (e._tag) {
            case "SignatureMismatch":
              return errorResponse(401, "signature_error", "Webhook signature verification failed.");
            case "PayloadShapeInvalid":
              return errorResponse(400, "invalid_request", `Malformed issue_comment payload: ${e.reason}.`);
            case "SecretMissing":
              return errorResponse(403, "configuration_error", `No webhook secret for '${e.repo as unknown as string}'.`);
            default:
              return absurd(e);
          }
        }

        const outcome = await handleClassifiedWebhook(classified.value, ctx);
        if (outcome._tag === "Err") {
          const e = outcome.error;
          switch (e._tag) {
            case "AoSpawnFailed":
              return errorResponse(502, "dispatch_failed", `ao spawn failed (exit ${e.exitCode}).`);
            case "TokenMintFailed":
              return errorResponse(503, "auth_unavailable", "Installation token unavailable.");
            case "ProjectNotConfigured":
              return errorResponse(403, "configuration_error", `Repo '${e.repo as unknown as string}' not routed.`);
            default:
              return absurd(e);
          }
        }

        return Response.json({ ok: true, outcome: outcome.value });
      }

      return errorResponse(404, "not_found", "Resource not found.");
    },
  });

  await registerAll(current);

  const running: RunningBridge = {
    async stop(): Promise<void> {
      if (stopHeartbeat) stopHeartbeat();
      await deregisterAll(current);
      server.stop();
    },
    async reload(nextConfig: BridgeConfig): Promise<void> {
      current = nextConfig;
      await registerAll(current);
    },
  };
  return running;
}

function resolveSecret(repo: RepoFullName, cfg: BridgeConfig): string | null {
  const route = cfg.repos.get(repo);
  if (!route) {
    // Fall back to shared secret env var.
    return process.env.ZAPBOT_API_KEY ?? null;
  }
  const perRepo = process.env[route.webhookSecretEnvVar];
  if (perRepo) return perRepo;
  return process.env.ZAPBOT_API_KEY ?? null;
}
