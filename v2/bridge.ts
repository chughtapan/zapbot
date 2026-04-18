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
import { parseMention } from "./mention-parser.ts";
import { dispatch } from "./ao/dispatcher.ts";
import { getIssue, listOpenIssuesWithLabel, postComment as ghPostComment } from "./github-state.ts";
import {
  absurd,
  asDeliveryId,
  asRepoFullName,
} from "./types.ts";
import type {
  BotUsername,
  DispatchError,
  InstallationToken,
  IssueNumber,
  ProjectName,
  RepoFullName,
  Result,
} from "./types.ts";
import { createGitHubClient, getInstallationToken } from "../src/github/client.ts";
import { errorResponse } from "../src/http/error-response.ts";

const WRITE_PERMISSIONS = new Set(["write", "maintain", "admin"]);

// ── Boot config ─────────────────────────────────────────────────────

export interface BridgeConfig {
  readonly port: number;
  readonly publicUrl: string;
  readonly gatewayUrl: string;
  readonly gatewaySecret: string | null;
  readonly botUsername: BotUsername;
  readonly aoConfigPath: string;
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
  readonly mintToken: () => Promise<InstallationToken>;
  readonly config: BridgeConfig;
}

export type HandleOutcome =
  | { readonly kind: "ignored"; readonly reason: string }
  | { readonly kind: "dispatched"; readonly repo: RepoFullName; readonly session: string }
  | { readonly kind: "unauthorized"; readonly actor: string }
  | { readonly kind: "command_unknown"; readonly raw: string };

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
  const gh = createGitHubClient();

  // Eyes reaction for immediate UX feedback (best-effort).
  try {
    await gh.addReaction(c.repo as unknown as string, c.commentId as unknown as number, "eyes");
  } catch {
    // ignored
  }

  // Permission check
  try {
    const perm = await gh.getUserPermission(c.repo as unknown as string, c.triggeredBy);
    if (!WRITE_PERMISSIONS.has(perm)) {
      await gh.postComment(
        c.repo as unknown as string,
        c.issue as unknown as number,
        `Sorry @${c.triggeredBy}, you need write access to this repo to use commands.`
      );
      return { _tag: "Ok", value: { kind: "unauthorized", actor: c.triggeredBy } };
    }
  } catch {
    await gh.postComment(
      c.repo as unknown as string,
      c.issue as unknown as number,
      `Sorry @${c.triggeredBy}, I couldn't verify your permissions right now. Please try again in a moment.`
    );
    return { _tag: "Ok", value: { kind: "unauthorized", actor: c.triggeredBy } };
  }

  const cmd = c.command;
  switch (cmd.kind) {
    case "plan_this":
    case "investigate_this": {
      const route = ctx.config.repos.get(c.repo);
      if (route === undefined) {
        return { _tag: "Err", error: { _tag: "ProjectNotConfigured", repo: c.repo } };
      }
      let token: InstallationToken;
      try {
        token = await ctx.mintToken();
      } catch (e) {
        return { _tag: "Err", error: { _tag: "TokenMintFailed", cause: String(e) } };
      }
      const result = await dispatch({
        repo: c.repo,
        issue: c.issue,
        projectName: route.projectName,
        configPath: ctx.config.aoConfigPath,
        installationToken: token,
      });
      if (result._tag === "Err") return result;
      await gh.postComment(
        c.repo as unknown as string,
        c.issue as unknown as number,
        `Dispatching agent for @${c.triggeredBy}. Session: \`${result.value as unknown as string}\`.`
      );
      return { _tag: "Ok", value: { kind: "dispatched", repo: c.repo, session: result.value as unknown as string } };
    }
    case "status": {
      const summary = await summarizeIssue(c.repo, c.issue);
      await gh.postComment(c.repo as unknown as string, c.issue as unknown as number, summary);
      return { _tag: "Ok", value: { kind: "ignored", reason: "status posted" } };
    }
    case "unknown_command": {
      await gh.postComment(
        c.repo as unknown as string,
        c.issue as unknown as number,
        `@${c.triggeredBy} I don't recognize the command \`${cmd.raw}\`. Try \`plan this\`, \`investigate this\`, or \`status\`.`
      );
      return { _tag: "Ok", value: { kind: "command_unknown", raw: cmd.raw } };
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

// Re-export so callers at the edge have a one-stop import for postComment.
export { ghPostComment as postComment, listOpenIssuesWithLabel };

// ── Server boot ─────────────────────────────────────────────────────

/**
 * Boot the HTTP server, register every configured repo with the gateway,
 * start heartbeats, install SIGHUP → reload. Returns a handle for stop/reload.
 */
export async function startBridge(config: BridgeConfig): Promise<RunningBridge> {
  let current = config;
  let stopHeartbeat: (() => void) | null = null;

  const gatewayClient: GatewayClientConfig = {
    gatewayUrl: current.gatewayUrl,
    secret: current.gatewaySecret,
    token: null,
  };

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

  const ctx: BridgeHandlerContext = {
    mintToken: async () => {
      const t = await getInstallationToken();
      if (!t) throw new Error("no installation token available");
      return t as unknown as InstallationToken;
    },
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
            case "InvalidJson":
              return errorResponse(400, "invalid_request", "Invalid payload.");
            case "UnconfiguredRepo":
              return errorResponse(403, "configuration_error", `Repo '${e.repo as unknown as string}' is not configured.`);
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

  const sighupHandler = () => {
    // Caller rewires via `running.reload(newConfig)`; the server-side SIGHUP
    // handler is installed by the CLI entrypoint, not by this function.
  };
  void sighupHandler;

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
  // Reference gatewayClient so it's not an unused binding — we use it as the
  // boot-time snapshot; actual requests read `current`.
  void gatewayClient;
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
