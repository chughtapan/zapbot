/**
 * bridge — thinned HTTP bridge.
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
import { getIssue, postComment as postGitHubComment } from "./github-state.ts";
import { mirrorDurableStatusComment, type DurableStatusComment } from "./github/comment-mirroring.ts";
import { resolveThreadMirrorTargets, type IssueThreadAnchor } from "./github/thread-links.ts";
import {
  buildMoltzapProcessEnv,
  type MoltzapRuntimeConfig,
} from "./moltzap/runtime.ts";
import type { IngressPolicy } from "./config/ingress.ts";
import { createAoCliControlHost, forwardControlPrompt, type AoControlHost, type ForwardControlError } from "./orchestrator/runtime.ts";
import { toOrchestratorControlPrompt, type ControlEventShapeError, type OrchestratorControlEvent } from "./orchestrator/control-event.ts";
import {
  absurd,
  asDeliveryId,
  asRepoFullName,
  err,
  ok,
} from "./types.ts";
import type {
  BotUsername,
  GhCallError,
  HandleOutcome,
  IssueNumber,
  ProjectName,
  RepoFullName,
  Result,
} from "./types.ts";
import { createGitHubClient, getInstallationToken } from "./github/client.ts";
import { createLogger } from "./logger.ts";
import { errorResponse } from "./http/error-response.ts";
import {
  handleInstallationTokenRequest,
  type MintedInstallationToken,
  type InstallationTokenStatus,
} from "./http/routes/installation-token.ts";

const WRITE_PERMISSIONS = new Set(["write", "maintain", "admin"]);
const log = createLogger("bridge");

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
  readonly ingress: IngressPolicy;
  readonly publicUrl: string | null;
  readonly gatewayUrl: string | null;
  readonly gatewaySecret: string | null;
  readonly botUsername: BotUsername;
  readonly aoConfigPath: string;
  /** Bearer for the loopback broker route (GET /api/tokens/installation). */
  readonly apiKey: string;
  /** HMAC-SHA256 secret for GitHub webhooks. Must differ from `apiKey`. */
  readonly webhookSecret: string;
  readonly moltzap: MoltzapRuntimeConfig;
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
  readonly mintToken: () => Promise<MintedInstallationToken | null>;
  readonly gh: GhAdapter;
  readonly aoControlHost: AoControlHost;
  readonly config: BridgeConfig;
}

export interface GhAdapter {
  readonly addReaction: (repo: RepoFullName, commentId: number, reaction: string) => Promise<Result<void, GhCallError>>;
  readonly getUserPermission: (repo: RepoFullName, user: string) => Promise<Result<string, GhCallError>>;
  readonly postComment: (repo: RepoFullName, issue: IssueNumber, body: string) => Promise<Result<void, GhCallError>>;
}

export type { HandleOutcome } from "./types.ts";
type BridgeHotPathError =
  | { readonly _tag: "ProjectNotConfigured"; readonly repo: RepoFullName }
  | ControlEventShapeError
  | ForwardControlError;

// ── Handler ─────────────────────────────────────────────────────────

/**
 * Dispatch a classified webhook. Pure over the handler context; no access
 * to server globals. Returns an outcome or a `DispatchError`.
 */
export async function handleClassifiedWebhook(
  classified: ClassifiedWebhook,
  ctx: BridgeHandlerContext
): Promise<Result<HandleOutcome, BridgeHotPathError>> {
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
): Promise<Result<HandleOutcome, BridgeHotPathError>> {
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
      const controlEvent: OrchestratorControlEvent = {
        _tag: "GitHubControlEvent",
        repo: c.repo,
        projectName: route.projectName,
        issue: c.issue,
        commentId: c.commentId,
        deliveryId: c.deliveryId,
        commentBody: c.commentBody,
        triggeredBy: c.triggeredBy,
      };
      const prompt = toOrchestratorControlPrompt(controlEvent);
      if (prompt._tag === "Err") {
        return err(prompt.error);
      }
      const forwarded = await forwardControlPrompt(route.projectName, prompt.value, ctx.aoControlHost);
      if (forwarded._tag === "Err") {
        return err(forwarded.error);
      }
      const session = forwarded.value.session;
      await postDurableStatusComment(
        { repo: c.repo, issue: c.issue },
        {
          source: "bridge",
          body: `Forwarded control event for @${c.triggeredBy}. Session: \`${session as unknown as string}\`.`,
        },
        ctx,
      );
      return ok({ kind: "dispatched", repo: c.repo, session });
    }
    case "status": {
      const summary = await summarizeIssue(c.repo, c.issue);
      await postDurableStatusComment(
        { repo: c.repo, issue: c.issue },
        { source: "bridge", body: summary },
        ctx,
      );
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

async function postDurableStatusComment(
  anchor: IssueThreadAnchor,
  comment: DurableStatusComment,
  ctx: BridgeHandlerContext,
): Promise<void> {
  const targets = await resolveThreadMirrorTargets(anchor);
  if (targets._tag === "Err") {
    log.warn(
      `durable_comment_target_lookup_failed repo=${anchor.repo as unknown as string} issue=${anchor.issue as unknown as number} cause=${targets.error._tag}`,
    );
    const fallback = await ctx.gh.postComment(anchor.repo, anchor.issue, comment.body);
    if (fallback._tag === "Err") {
      log.warn(
        `durable_comment_issue_post_failed repo=${anchor.repo as unknown as string} issue=${anchor.issue as unknown as number} cause=${fallback.error.cause}`,
      );
    }
    return;
  }

  const receipt = await mirrorDurableStatusComment(
    targets.value,
    comment,
    { postComment: postGitHubComment },
  );
  if (receipt._tag === "Err") {
    const fallback = await ctx.gh.postComment(anchor.repo, anchor.issue, comment.body);
    if (fallback._tag === "Err") {
      log.warn(
        `durable_comment_issue_post_failed repo=${anchor.repo as unknown as string} issue=${anchor.issue as unknown as number} cause=${receipt.error.cause}`,
      );
    }
    return;
  }
  if (receipt.value.linkedPullRequestMirror._tag === "Failed") {
    log.warn(
      `durable_comment_pr_mirror_failed repo=${anchor.repo as unknown as string} issue=${anchor.issue as unknown as number} linked_pr=${targets.value.linkedPullRequest as unknown as number} cause=${receipt.value.linkedPullRequestMirror.cause}`,
    );
  }
}

// ── Server boot ─────────────────────────────────────────────────────

/**
 * Build the default `GhAdapter` that wraps v1 `createGitHubClient()` with
 * `safeGh`. Client construction is lazy — we do not instantiate the
 * Octokit until the first call, so `startBridge` boots cleanly in
 * environments (tests, cold installs) where no GitHub credentials are
 * configured yet. Construction failure is mapped to a typed `GhCallError`
 * rather than a boot-time throw.
 *
 * Tests substitute their own adapter via `BridgeHandlerContext`.
 */
export function buildDefaultGhAdapter(): GhAdapter {
  let cached: ReturnType<typeof createGitHubClient> | null = null;
  async function lazy<T>(label: string, fn: (gh: ReturnType<typeof createGitHubClient>) => Promise<T>): Promise<Result<T, GhCallError>> {
    if (cached === null) {
      try {
        cached = createGitHubClient();
      } catch (e) {
        const cause = e instanceof Error ? e.message : String(e);
        log.warn(`gh_call_failed label=${label} cause=${cause}`);
        return err({ _tag: "GhCallFailed", label, cause });
      }
    }
    return safeGh(label, () => fn(cached!));
  }
  return {
    addReaction: (repo, commentId, reaction) =>
      lazy("addReaction", (gh) => gh.addReaction(repo as unknown as string, commentId, reaction)),
    getUserPermission: (repo, user) =>
      lazy("getUserPermission", (gh) => gh.getUserPermission(repo as unknown as string, user)),
    postComment: (repo, issue, body) =>
      lazy("postComment", async (gh) => {
        await gh.postComment(repo as unknown as string, issue as unknown as number, body);
      }),
  };
}

/**
 * Pure request router. Extracted from `startBridge` so tests can exercise
 * the HTTP surface without booting `Bun.serve`. `getConfig` is a getter
 * so SIGHUP reload is visible to the handler without re-building the
 * closure.
 */
export function buildFetchHandler(
  getConfig: () => BridgeConfig,
  ctx: BridgeHandlerContext
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const current = getConfig();
    const url = new URL(req.url);
    const pathname = url.pathname;

    if (pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }

    // Installation token broker (paired with safer-by-default#50).
    if (pathname === "/api/tokens/installation" && req.method === "GET") {
      const result: InstallationTokenStatus = await handleInstallationTokenRequest(req, {
        mintToken: ctx.mintToken,
        apiKey: current.apiKey,
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

      const repoName =
        (payload as { repository?: { full_name?: string } })?.repository?.full_name ?? "";
      const repo = asRepoFullName(repoName);

      // Repo enumeration pre-auth oracle: don't distinguish unknown-repo
      // from bad signature. `verifyAndClassify` will fail HMAC on secret
      // mismatch regardless; we also refuse unknown repos up front with
      // the same 401 body so the two states are indistinguishable to an
      // unauthenticated caller.
      const configuredAndUnknown =
        current.repos.size > 0 && repoName !== "" && !current.repos.has(repo);

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

      if (configuredAndUnknown) {
        return errorResponse(401, "signature_error", "Webhook signature verification failed.");
      }
      if (classified._tag === "Err") {
        const e = classified.error;
        switch (e._tag) {
          case "SignatureMismatch":
          case "SecretMissing":
            return errorResponse(401, "signature_error", "Webhook signature verification failed.");
          case "PayloadShapeInvalid":
            return errorResponse(400, "invalid_request", `Malformed issue_comment payload: ${e.reason}.`);
          default:
            return absurd(e);
        }
      }

      const outcome = await handleClassifiedWebhook(classified.value, ctx);
      if (outcome._tag === "Err") {
        const e = outcome.error;
      switch (e._tag) {
          case "AoStartFailed":
            return errorResponse(503, "dispatch_unavailable", `ao start failed: ${e.cause}.`);
          case "OrchestratorNotFound":
            return errorResponse(503, "dispatch_unavailable", `No orchestrator found for ${e.projectName as unknown as string}.`);
          case "OrchestratorNotReady":
            return errorResponse(503, "dispatch_unavailable", `Orchestrator for ${e.projectName as unknown as string} is not ready: ${e.reason}.`);
          case "AoSendFailed":
            return errorResponse(502, "dispatch_failed", `ao send failed: ${e.cause}.`);
          case "PromptShapeInvalid":
            return errorResponse(400, "invalid_request", `Orchestrator prompt invalid: ${e.reason}.`);
          case "ProjectNotConfigured":
            return errorResponse(403, "configuration_error", `Repo '${e.repo as unknown as string}' not routed.`);
          default:
            return absurd(e);
        }
      }

      return Response.json({ ok: true, outcome: outcome.value });
    }

    return errorResponse(404, "not_found", "Resource not found.");
  };
}

/**
 * Default `mintToken` implementation — delegates to the v1 singleton
 * `getInstallationToken` and preserves the broker's minted token contract.
 */
export async function defaultMintToken(): Promise<MintedInstallationToken | null> {
  return await getInstallationToken();
}

/**
 * Boot the HTTP server, register every configured repo with the gateway,
 * start heartbeats, install SIGHUP → reload. Returns a handle for stop/reload.
 */
export async function startBridge(config: BridgeConfig): Promise<RunningBridge> {
  let current = config;
  let stopHeartbeat: (() => void) | null = null;

  async function registerAll(cfg: BridgeConfig): Promise<void> {
    if (stopHeartbeat) {
      stopHeartbeat();
      stopHeartbeat = null;
    }
    const repos = Array.from(cfg.repos.keys());
    if (repos.length === 0) return;
    if (cfg.ingress.mode === "local-only") return;
    if (cfg.gatewayUrl === null || cfg.publicUrl === null) return;
    const gatewayUrl = cfg.gatewayUrl;
    const publicUrl = cfg.publicUrl;
    const client: GatewayClientConfig = {
      gatewayUrl,
      secret: cfg.gatewaySecret,
      token: null,
    };
    await Promise.allSettled(
      repos.map((repo) => registerBridge(client, repo, publicUrl))
    );
    const intervalMs = parseInt(process.env.ZAPBOT_GATEWAY_HEARTBEAT_MS ?? "300000", 10);
    stopHeartbeat = startHeartbeat(client, repos, publicUrl, intervalMs);
  }

  async function deregisterAll(cfg: BridgeConfig): Promise<void> {
    if (cfg.ingress.mode === "local-only") return;
    if (cfg.gatewayUrl === null || cfg.publicUrl === null) return;
    const gatewayUrl = cfg.gatewayUrl;
    const publicUrl = cfg.publicUrl;
    const repos = Array.from(cfg.repos.keys());
    const client: GatewayClientConfig = {
      gatewayUrl,
      secret: cfg.gatewaySecret,
      token: null,
    };
    await Promise.allSettled(
      repos.map((repo) => deregisterBridge(client, repo, publicUrl))
    );
  }

  const ghAdapter = buildDefaultGhAdapter();
  let aoControlHost = createAoCliControlHost({
    configPath: current.aoConfigPath,
    env: {
      ...process.env,
      ...buildMoltzapProcessEnv(current.moltzap),
    },
  });
  const ctx: BridgeHandlerContext = {
    mintToken: defaultMintToken,
    gh: ghAdapter,
    get aoControlHost() {
      return aoControlHost;
    },
    get config() {
      return current;
    },
  };

  const handler = buildFetchHandler(() => current, ctx);
  const server = Bun.serve({ port: current.port, fetch: handler });

  await registerAll(current);

  const running: RunningBridge = {
    async stop(): Promise<void> {
      if (stopHeartbeat) {
        stopHeartbeat();
        stopHeartbeat = null;
      }
      await deregisterAll(current);
      server.stop();
    },
    async reload(nextConfig: BridgeConfig): Promise<void> {
      await deregisterAll(current);
      current = nextConfig;
      aoControlHost = createAoCliControlHost({
        configPath: current.aoConfigPath,
        env: {
          ...process.env,
          ...buildMoltzapProcessEnv(current.moltzap),
        },
      });
      await registerAll(current);
    },
  };
  return running;
}

function resolveSecret(_repo: RepoFullName, cfg: BridgeConfig): string | null {
  return cfg.webhookSecret;
}
