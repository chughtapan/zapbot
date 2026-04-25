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

import { readFileSync } from "node:fs";
import { verifyAndClassify, registerBridge, deregisterBridge, startHeartbeat } from "./gateway.ts";
import type { GatewayClientConfig, GatewayWebhookEnvelope, ClassifiedWebhook } from "./gateway.ts";
import { getIssue } from "./github-state.ts";
import {
  buildMoltzapProcessEnv,
  loadMoltzapRuntimeConfig,
  type MoltzapRuntimeConfig,
} from "./moltzap/runtime.ts";
import {
  deriveConfigSourcePaths,
  loadBridgeRuntimeConfig,
} from "./config/load.ts";
import { resolveRuntimeEnv } from "./config/env.ts";
import { readCanonicalConfig } from "./config/canonical.ts";
import { resolveIngressPolicy } from "./config/ingress.ts";
import type { IngressResolutionError } from "./config/ingress.ts";
import { parseProjectConfig, readConfigFiles } from "./config/disk.ts";
import type {
  BridgeRuntimeConfig,
  ConfigDiskError,
  ConfigReloadError,
} from "./config/types.ts";
import type { IngressPolicy } from "./config/ingress.ts";
import {
  createAoCliControlHost,
  createAoCliRosterManagerDeps,
  createRosterBudgetCoordinator,
  forwardControlPrompt,
  type AoControlHost,
  type ForwardControlError,
  type RosterBudgetCoordinator,
} from "./orchestrator/runtime.ts";
import { createRosterManager, type RosterManager } from "./orchestrator/roster.ts";
import { toOrchestratorControlPrompt, type ControlEventShapeError, type OrchestratorControlEvent } from "./orchestrator/control-event.ts";
import { asMoltzapSenderId } from "./moltzap/types.ts";
import {
  bootBridgeApp,
  bridgeAgentId,
  shutdownBridgeApp,
  drainBridgeSessions,
  type BridgeAppBootError,
} from "./moltzap/bridge-app.ts";
import { bridgeAgentIdAsSenderId } from "./moltzap/bridge-identity.ts";
import { Effect } from "effect";
import {
  absurd,
  asDeliveryId,
  asIssueNumber,
  asRepoFullName,
  err,
  ok,
} from "./types.ts";
import type {
  BotUsername,
  DispatchError,
  GhCallError,
  GithubStateError,
  HandleOutcome,
  InstallationToken,
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
  type InstallationTokenStatus,
} from "./http/routes/installation-token.ts";
import { installBridgeProcessLifecycle } from "./bridge-process.ts";

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
  readonly mintToken: () => Promise<Result<InstallationToken, DispatchError>>;
  readonly gh: GhAdapter;
  readonly aoControlHost: AoControlHost;
  /**
   * WS2 MVP (sbd#149) budget enforcement seam: the RosterManager tracks
   * spawned worker sessions per-roster; the coordinator folds ingress +
   * tick events into its two-gate budget state machine (SPEC §5(g)).
   * Production handlers invoke the coordinator's observe* methods; the
   * boot-time periodic tick drives stepBudget across all active rosters.
   */
  readonly roster: RosterManager;
  readonly rosterBudgetCoordinator: RosterBudgetCoordinator;
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
type IssueEventSource = {
  readonly type?: string | null;
  readonly pull_request?: {
    readonly number?: number | null;
    readonly repository_url?: string | null;
  } | null;
  readonly issue?: {
    readonly number?: number | null;
    readonly repository_url?: string | null;
  } | null;
};
type IssueEventSnapshot = {
  readonly event?: string | null;
  readonly created_at?: string | null;
  readonly source?: IssueEventSource | null;
};
type IssueThreadAnchor = {
  readonly repo: RepoFullName;
  readonly issue: IssueNumber;
};
const GITHUB_API_BASE_URL = "https://api.github.com";

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
      // SPEC §5(g) wiring: a forwarded control prompt is a peer event
      // on the orchestrator's session; fold it into the coordinator's
      // idle-clock state via observeInboundPeerMessage. Budget-trip
      // evaluation runs on the periodic tick set up in `runBridge`
      // (30s interval); firing tick synchronously per-event would
      // stack async work under load without changing correctness.
      ctx.rosterBudgetCoordinator.observeInboundPeerMessage({
        session,
        atMs: Date.now(),
      });
      await postDurableStatusComment(
        { repo: c.repo, issue: c.issue },
        `Forwarded control event for @${c.triggeredBy}. Session: \`${session as unknown as string}\`.`,
        ctx,
      );
      return ok({ kind: "dispatched", repo: c.repo, session });
    }
    case "status": {
      const summary = await summarizeIssue(c.repo, c.issue);
      await postDurableStatusComment({ repo: c.repo, issue: c.issue }, summary, ctx);
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
  body: string,
  ctx: BridgeHandlerContext,
): Promise<void> {
  const issueComment = await ctx.gh.postComment(anchor.repo, anchor.issue, body);
  if (issueComment._tag === "Err") {
    log.warn(
      `durable_comment_issue_post_failed repo=${anchor.repo as unknown as string} issue=${anchor.issue as unknown as number} cause=${issueComment.error.cause}`,
    );
    return;
  }

  const linkedPullRequest = await getLinkedPullRequest(anchor.repo, anchor.issue);
  if (linkedPullRequest._tag === "Err") {
    log.warn(
      `durable_comment_target_lookup_failed repo=${anchor.repo as unknown as string} issue=${anchor.issue as unknown as number} cause=${linkedPullRequest.error._tag}`,
    );
    return;
  }
  if (linkedPullRequest.value === null) {
    return;
  }

  const mirroredComment = await ctx.gh.postComment(anchor.repo, linkedPullRequest.value, body);
  if (mirroredComment._tag === "Err") {
    log.warn(
      `durable_comment_pr_mirror_failed repo=${anchor.repo as unknown as string} issue=${anchor.issue as unknown as number} linked_pr=${linkedPullRequest.value as unknown as number} cause=${mirroredComment.error.cause}`,
    );
  }
}

async function getLinkedPullRequest(
  repo: RepoFullName,
  issue: IssueNumber,
): Promise<Result<IssueNumber | null, GithubStateError>> {
  const token = await getGitHubApiToken();
  if (token === null) {
    return err({ _tag: "GitHubAuthMissing" });
  }

  const { owner, repoName } = splitRepo(repo);
  const events: IssueEventSnapshot[] = [];
  for (let page = 1; ; page += 1) {
    const pageResult = await fetchIssueEventsPage(owner, repoName, issue, page, token);
    if (pageResult._tag === "Err") {
      return err(pageResult.error);
    }
    events.push(...pageResult.value);
    if (pageResult.value.length < 100) {
      break;
    }
  }
  return ok(findLinkedPullRequest(events, repo));
}

async function getGitHubApiToken(): Promise<string | null> {
  const pat = process.env.ZAPBOT_GITHUB_TOKEN?.trim();
  if (pat) {
    return pat;
  }
  try {
    const installationToken = await getInstallationToken();
    return installationToken?.token ?? null;
  } catch {
    return null;
  }
}

function splitRepo(repo: RepoFullName): { owner: string; repoName: string } {
  const [owner, repoName] = (repo as unknown as string).split("/");
  return { owner, repoName };
}

async function fetchIssueEventsPage(
  owner: string,
  repoName: string,
  issue: IssueNumber,
  page: number,
  token: string,
): Promise<Result<ReadonlyArray<IssueEventSnapshot>, GithubStateError>> {
  const issueNumber = issue as unknown as number;
  const url = `${GITHUB_API_BASE_URL}/repos/${owner}/${repoName}/issues/${issueNumber}/events?per_page=100&page=${page}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "zapbot-bridge",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err({ _tag: "GitHubApiFailed", status: -1, message });
  }

  if (!response.ok) {
    if (response.status === 404) {
      return err({ _tag: "IssueNotFound", repo: asRepoFullName(`${owner}/${repoName}`), issue });
    }
    const body = await readResponseText(response);
    return err({
      _tag: "GitHubApiFailed",
      status: response.status,
      message: body || `issue events request failed with status ${response.status}`,
    });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err({ _tag: "GitHubApiFailed", status: response.status, message });
  }
  return decodeIssueEventPage(payload);
}

async function readResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function decodeIssueEventPage(
  payload: unknown,
): Result<ReadonlyArray<IssueEventSnapshot>, GithubStateError> {
  if (!Array.isArray(payload)) {
    return err({ _tag: "GitHubApiFailed", status: -1, message: "issue events payload was not an array" });
  }

  const events: IssueEventSnapshot[] = [];
  for (const entry of payload) {
    const decoded = decodeIssueEvent(entry);
    if (decoded._tag === "Err") {
      return decoded;
    }
    events.push(decoded.value);
  }
  return ok(events);
}

function decodeIssueEvent(entry: unknown): Result<IssueEventSnapshot, GithubStateError> {
  if (!isJsonObject(entry)) {
    return err({ _tag: "GitHubApiFailed", status: -1, message: "issue event entry was not an object" });
  }

  const event = decodeOptionalString(entry.event, "issue event entry had invalid event");
  if (event._tag === "Err") {
    return event;
  }
  const createdAt = decodeOptionalString(entry.created_at, "issue event entry had invalid created_at");
  if (createdAt._tag === "Err") {
    return createdAt;
  }
  const source = decodeIssueEventSource(entry.source);
  if (source._tag === "Err") {
    return source;
  }
  return ok({
    event: event.value,
    created_at: createdAt.value,
    source: source.value,
  });
}

function decodeIssueEventSource(
  value: unknown,
): Result<IssueEventSource | null, GithubStateError> {
  if (value === undefined || value === null) {
    return ok(null);
  }
  if (!isJsonObject(value)) {
    return err({ _tag: "GitHubApiFailed", status: -1, message: "issue event entry had invalid source" });
  }

  const type = decodeOptionalString(value.type, "issue event source had invalid type");
  if (type._tag === "Err") {
    return type;
  }

  const issue = decodeIssueNumberSource(value.issue, "issue");
  if (issue._tag === "Err") {
    return issue;
  }
  const pullRequest = decodeIssueNumberSource(value.pull_request, "pull_request");
  if (pullRequest._tag === "Err") {
    return pullRequest;
  }

  return ok({
    type: type.value,
    issue: issue.value,
    pull_request: pullRequest.value,
  });
}

function decodeIssueNumberSource(
  value: unknown,
  fieldName: "issue" | "pull_request",
): Result<{ readonly number?: number | null; readonly repository_url?: string | null } | null, GithubStateError> {
  if (value === undefined || value === null) {
    return ok(null);
  }
  if (!isJsonObject(value)) {
    return err({ _tag: "GitHubApiFailed", status: -1, message: `issue event source had invalid ${fieldName}` });
  }

  const number = decodeOptionalNumber(
    value.number,
    `issue event source ${fieldName} had invalid number`,
  );
  if (number._tag === "Err") {
    return number;
  }
  const repositoryUrl = decodeOptionalString(
    value.repository_url,
    `issue event source ${fieldName} had invalid repository_url`,
  );
  if (repositoryUrl._tag === "Err") {
    return repositoryUrl;
  }
  return ok({ number: number.value, repository_url: repositoryUrl.value });
}

function decodeOptionalString(
  value: unknown,
  message: string,
): Result<string | null | undefined, GithubStateError> {
  if (value === undefined || value === null) {
    return ok(value);
  }
  if (typeof value === "string") {
    return ok(value);
  }
  return err({ _tag: "GitHubApiFailed", status: -1, message });
}

function decodeOptionalNumber(
  value: unknown,
  message: string,
): Result<number | null | undefined, GithubStateError> {
  if (value === undefined || value === null) {
    return ok(value);
  }
  if (typeof value === "number") {
    return ok(value);
  }
  return err({ _tag: "GitHubApiFailed", status: -1, message });
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function findLinkedPullRequest(
  events: ReadonlyArray<IssueEventSnapshot>,
  anchorRepo: RepoFullName,
): IssueNumber | null {
  let latestAt = Number.NEGATIVE_INFINITY;
  let linkedPullRequest: IssueNumber | null = null;
  for (const event of events) {
    if (event.event !== "cross-referenced") {
      continue;
    }
    if (!isSameRepoSource(event.source, anchorRepo)) {
      continue;
    }
    const pullRequestNumber = extractPullRequestNumber(event.source);
    if (pullRequestNumber === null) {
      continue;
    }
    const createdAt = event.created_at ? Date.parse(event.created_at) : Number.NaN;
    if (Number.isNaN(createdAt)) {
      continue;
    }
    if (createdAt >= latestAt) {
      latestAt = createdAt;
      linkedPullRequest = pullRequestNumber;
    }
  }
  return linkedPullRequest;
}

/**
 * Cross-repo guard for durable mirroring. GitHub issue events surface
 * cross-references from any repository the viewer can see; the mirror
 * path posts to `anchorRepo`, so a cross-repo PR number would either
 * mirror to the WRONG repo or hit a 404. Real GitHub events always
 * carry `repository_url` on cross-referenced sources; an absent field
 * means a malformed/spoofed/proxied event and the conservative answer
 * is "do not mirror." Tests must construct fixtures with the field set.
 */
function isSameRepoSource(
  source: IssueEventSource | null | undefined,
  anchorRepo: RepoFullName,
): boolean {
  if (source === null || source === undefined) {
    return false;
  }
  const repoUrl = source.pull_request?.repository_url ?? source.issue?.repository_url ?? null;
  if (repoUrl === null || repoUrl === undefined) {
    return false;
  }
  return repoUrl.endsWith(`/repos/${anchorRepo as unknown as string}`);
}

function extractPullRequestNumber(source: IssueEventSource | null | undefined): IssueNumber | null {
  if (source === null || source === undefined) {
    return null;
  }
  if (source.type !== undefined && source.type !== null && source.type !== "pull_request") {
    return null;
  }
  const number = source.pull_request?.number ?? source.issue?.number ?? null;
  if (typeof number !== "number") {
    return null;
  }
  return asIssueNumber(number);
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
    // Thin wrapper around getInstallationToken() — no new mint path.
    if (pathname === "/api/tokens/installation" && req.method === "GET") {
      const result: InstallationTokenStatus = await handleInstallationTokenRequest(req, {
        mintToken: getInstallationToken,
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
 * `getInstallationToken` and maps `null`/throw into `DispatchError`.
 */
export async function defaultMintToken(): Promise<Result<InstallationToken, DispatchError>> {
  try {
    const t = await getInstallationToken();
    if (!t) return err({ _tag: "TokenMintFailed", cause: "no installation token available" });
    return ok(t.token as unknown as InstallationToken);
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    return err({ _tag: "TokenMintFailed", cause });
  }
}

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
      AO_CALLER_TYPE: "orchestrator",
      ...buildMoltzapProcessEnv(current.moltzap),
    },
  });
  // WS2 MVP (sbd#149) + sbd#200 rev 4: instantiate the RosterManager +
  // budget coordinator at boot. The manager tracks spawned worker
  // sessions; the coordinator folds MoltZap inbound events (via the
  // onInbound observer below) and a periodic tick (startPeriodicTick)
  // into the two-gate budget state machine. This is the production
  // wiring required by SPEC §5(g): stepBudget and record* are actually
  // invoked by ingress + the tick, not just in tests.
  //
  // Bridge identity (sbd#199 rev 4 §2 A+C(2)): when MoltZap is
  // registration-backed, boot the bridge's MoltZapApp before the roster
  // so `bridgeAgentId()` resolves to the just-registered id. The
  // literal `"zapbot-orchestrator"` fallback is gone — it only ever
  // matched when operators hand-set MOLTZAP_ORCHESTRATOR_SENDER_ID, and
  // registration-backed deployments cannot predict that value.
  //
  // MoltzapDisabled: no MoltZap at all. Keep a fixed senderId for the
  // few roster tests that run disabled; production never hits this path.
  if (current.moltzap._tag === "MoltzapRegistration") {
    const boot = await Effect.runPromise(
      bootBridgeApp({ serverUrl: current.moltzap.serverUrl }).pipe(
        Effect.either,
      ),
    );
    if (boot._tag === "Left") {
      throw new Error(`[bridge] bootBridgeApp failed: ${formatBridgeBootError(boot.left)}`);
    }
  }
  const orchestratorSenderId: ReturnType<typeof asMoltzapSenderId> = (() => {
    const registered = bridgeAgentId();
    if (registered !== null) return bridgeAgentIdAsSenderId(registered);
    return asMoltzapSenderId("zapbot-orchestrator");
  })();
  // sbd#201: when MoltZap is registration-backed, plumb auth into the
  // roster manager so the spawn dep can mint per-worker creds and call
  // `createBridgeSession({invitedAgentIds: [thisWorkerSenderId]})` BEFORE
  // each `ao spawn` (architect rev 4 §4.3).
  const moltzapAuth =
    current.moltzap._tag === "MoltzapRegistration" ? current.moltzap : null;
  const rosterManagerDeps = createAoCliRosterManagerDeps(
    {
      configPath: current.aoConfigPath,
      env: {
        ...process.env,
        AO_CALLER_TYPE: "orchestrator",
        ...buildMoltzapProcessEnv(current.moltzap),
      },
    },
    {
      orchestratorSenderId,
      moltzapAuth,
    },
  );
  const rosterManager = createRosterManager(rosterManagerDeps);
  const rosterBudgetCoordinator = createRosterBudgetCoordinator(rosterManager);
  const BUDGET_TICK_MS = 30_000; // 30s tick — idle gate resolution.
  const stopBudgetTick = rosterBudgetCoordinator.startPeriodicTick(BUDGET_TICK_MS);
  const ctx: BridgeHandlerContext = {
    mintToken: defaultMintToken,
    gh: ghAdapter,
    get aoControlHost() {
      return aoControlHost;
    },
    roster: rosterManager,
    rosterBudgetCoordinator,
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
      // Stop the budget tick so the process exits cleanly (SPEC §5(g)
      // periodic stepBudget runner).
      stopBudgetTick();
      await deregisterAll(current);
      server.stop();
      // sbd#200 rev 4 §4.6 SIGTERM drain: close active bridge sessions
      // under a bounded budget, then tear down the MoltZapApp. Order
      // matters — drain BEFORE shutdown so the SDK's unconditional
      // close-all does not pre-empt the budgeted close.
      if (current.moltzap._tag === "MoltzapRegistration") {
        const leaked = await drainBridgeSessions({ timeoutMs: 60_000 });
        if (leaked.length > 0) {
          console.warn(
            `[bridge] SIGTERM drain leaked ${leaked.length} session(s) (moltzap#230): ${leaked.join(",")}`,
          );
        }
        await Effect.runPromise(shutdownBridgeApp());
      }
    },
    async reload(nextConfig: BridgeConfig): Promise<void> {
      // Stop stale heartbeat when ingress mode flips github-demo → local-only.
      // registerAll returns early for local-only and never reaches the stopHeartbeat
      // call inside it, so the old heartbeat would keep running indefinitely.
      if (current.ingress.mode === "github-demo" && nextConfig.ingress.mode === "local-only") {
        stopHeartbeat?.();
        stopHeartbeat = null;
      }
      await deregisterAll(current);
      current = nextConfig;
      aoControlHost = createAoCliControlHost({
        configPath: current.aoConfigPath,
        env: {
          ...process.env,
          AO_CALLER_TYPE: "orchestrator",
          ...buildMoltzapProcessEnv(current.moltzap),
        },
      });
      await registerAll(current);
    },
  };
  return running;
}

function formatBridgeBootError(e: BridgeAppBootError): string {
  switch (e._tag) {
    case "BridgeAppAlreadyBooted":
      return "BridgeAppAlreadyBooted (singleton violated)";
    case "BridgeAppEnvInvalid":
      return `BridgeAppEnvInvalid: ${e.reason}`;
    case "BridgeAppRegistrationFailed":
      return `BridgeAppRegistrationFailed: ${e.cause._tag} (${JSON.stringify(e.cause)})`;
    case "BridgeAppManifestInvalid":
      return `BridgeAppManifestInvalid: ${e.cause.message}`;
    case "BridgeAppConnectFailed":
      return `BridgeAppConnectFailed: ${e.cause.message}`;
    case "BridgeAppSessionFailed":
      return `BridgeAppSessionFailed: ${e.cause.message}`;
    case "BridgeAppBootInterrupted":
      return `Bridge boot interrupted: ${e.reason}. Retry will start fresh.`;
    default:
      return absurd(e);
  }
}

function resolveSecret(repo: RepoFullName, cfg: BridgeConfig): string | null {
  const route = cfg.repos.get(repo);
  if (!route) {
    return cfg.webhookSecret;
  }
  const perRepo = process.env[route.webhookSecretEnvVar];
  if (perRepo) return perRepo;
  return cfg.webhookSecret;
}

// ── Bridge process orchestrator ─────────────────────────────────────
//
// Runtime sequencer for the bridge entrypoint: config load, Moltzap
// decode, post-boot reachability probe, SIGHUP reload, signal-driven
// shutdown. Lives here (not in the bin) so the surface is reachable
// by tests without a process fork.

const nodeDiskReader = {
  readText(path: string): Result<string, ConfigDiskError> {
    try {
      return ok(readFileSync(path, "utf-8"));
    } catch (cause) {
      return err({
        _tag: "ConfigFileUnreadable",
        path,
        cause: String(cause),
      });
    }
  },
};

/**
 * HTTP probe against the bridge's `/healthz` endpoint. Used post-boot
 * to confirm `ZAPBOT_BRIDGE_URL` is reachable from the public internet
 * before declaring the bridge ready.
 */
export async function probeHealthz(publicUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${publicUrl.replace(/\/+$/u, "")}/healthz`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Load bridge config from disk + env. The probe is injectable so the
 * initial load (before the server is up) can stub it out — the live
 * `/healthz` probe runs separately in `runBridgeProcess` after the
 * server is listening.
 */
export async function loadBridgeInputs(
  env: NodeJS.ProcessEnv,
  configPath: string | undefined,
  isPublicUrlReachable: (publicUrl: string) => Promise<boolean> = probeHealthz,
): Promise<Result<BridgeRuntimeConfig, { readonly reason: string }>> {
  const sourcePaths = deriveConfigSourcePaths(configPath, env);

  const canonical = readCanonicalConfig(sourcePaths.canonicalConfigPath, nodeDiskReader);
  if (canonical._tag === "Err") {
    return err({ reason: formatConfigError(canonical.error) });
  }

  const rawFiles = readConfigFiles(sourcePaths, nodeDiskReader);
  if (rawFiles._tag === "Err") {
    return err({ reason: formatConfigError(rawFiles.error) });
  }

  const runtimeEnv = resolveRuntimeEnv(env, canonical.value);
  if (runtimeEnv._tag === "Err") {
    return err({ reason: formatConfigError(runtimeEnv.error) });
  }

  const ingressMode = runtimeEnv.value.gatewayUrl === null ? "local-only" : "github-demo";
  const ingress = await resolveIngressPolicy({
    mode: ingressMode,
    gatewayUrl: runtimeEnv.value.gatewayUrl ?? "",
    publicUrl: runtimeEnv.value.publicUrl,
    isPublicUrlReachable,
  });
  if (ingress._tag === "Err") {
    return err({ reason: formatIngressError(ingress.error) });
  }

  const projectDocument = rawFiles.value.projectConfigText === null || sourcePaths.projectConfigPath === null
    ? ok(null)
    : parseProjectConfig(sourcePaths.projectConfigPath, rawFiles.value.projectConfigText);
  if (projectDocument._tag === "Err") {
    return err({ reason: formatConfigError(projectDocument.error) });
  }

  const runtime = loadBridgeRuntimeConfig(runtimeEnv.value, projectDocument.value, ingress.value);
  if (runtime._tag === "Err") {
    return err({ reason: formatConfigError(runtime.error) });
  }

  return ok(runtime.value);
}

/**
 * Build the boot-ready `BridgeConfig` from a resolved `BridgeRuntimeConfig`.
 * Folds in the Moltzap runtime decode (env-sourced) and projects routes.
 */
export function buildBridgeConfig(
  env: NodeJS.ProcessEnv,
  runtime: BridgeRuntimeConfig,
): Result<BridgeConfig, { readonly reason: string }> {
  const moltzap = loadMoltzapRuntimeConfig(env);
  if (moltzap._tag === "Err") {
    return err({ reason: moltzap.error.reason });
  }

  return ok({
    port: runtime.port,
    ingress: runtime.ingress,
    publicUrl: runtime.publicUrl,
    gatewayUrl: runtime.gatewayUrl,
    gatewaySecret: runtime.gatewaySecret,
    botUsername: runtime.botUsername,
    aoConfigPath: runtime.aoConfigPath ?? "",
    apiKey: runtime.apiKey,
    webhookSecret: runtime.webhookSecret,
    moltzap: moltzap.value,
    repos: buildRepos(runtime),
  });
}

function buildRepos(runtime: BridgeRuntimeConfig): ReadonlyMap<RepoFullName, RepoRoute> {
  const result = new Map<RepoFullName, RepoRoute>();
  for (const [repoFullName, entry] of runtime.routes) {
    result.set(asRepoFullName(repoFullName), {
      projectName: entry.projectName,
      webhookSecretEnvVar: entry.webhookSecretEnvVar,
      defaultBranch: entry.defaultBranch,
    });
  }
  return result;
}

export function formatConfigError(error: ConfigReloadError): string {
  switch (error._tag) {
    case "InvalidPort":
      return `Invalid ZAPBOT_PORT value: ${error.raw}`;
    case "SecretCollision":
      return `${error.left} must not equal ${error.right}.`;
    case "ConfigFileUnreadable":
      return `Cannot read config file ${error.path}: ${error.cause}`;
    case "ConfigFileInvalid":
      return `Invalid config file ${error.path}: ${error.cause}`;
    case "CanonicalConfigMissing":
      return `Canonical config not found at ${error.path}. Run zapbot-team-init to create it.`;
    case "CanonicalConfigInvalid":
      return `Invalid canonical config at ${error.path}: ${error.cause}`;
    case "DeprecatedSecretBinding":
      return `Project ${error.projectName} uses deprecated webhook secret env var ${error.secretEnvVar}.`;
    case "ReloadRejected":
      return error.reason;
    default:
      return absurd(error);
  }
}

export function formatIngressError(error: IngressResolutionError): string {
  switch (error._tag) {
    case "InvalidIngressMode":
      return `Unsupported ingress mode: ${error.mode}`;
    case "MissingPublicBridgeUrl":
      return "ZAPBOT_BRIDGE_URL is required in GitHub demo mode.";
    case "UnreachablePublicBridgeUrl":
      return `ZAPBOT_BRIDGE_URL is unreachable: ${error.publicUrl}`;
    case "DemoModeRequiresGateway":
      return "ZAPBOT_GATEWAY_URL is required in GitHub demo mode.";
    default:
      return absurd(error);
  }
}

/**
 * Run the bridge process: install signal handlers, load config, boot
 * the HTTP server. Returns once `markReady` has handed ownership of
 * `running` to the lifecycle. The lifecycle owns SIGHUP reload and
 * SIGINT/SIGTERM shutdown; the HTTP server keeps the event loop alive
 * until `running.stop()` resolves and `process.exit` is requested.
 *
 * On config-load failure, the lifecycle exits with code 1.
 *
 * Race fixes (sbd#215, see `bridge-process.ts` module header):
 *   - Race 1: `installBridgeProcessLifecycle` is the FIRST line — signal
 *     handlers exist throughout boot.
 *   - Race 2: `liveRuntime` advances inside the lifecycle's SIGHUP path
 *     ONLY after `commitReload` resolves Ok.
 *   - Race 3: SIGHUP no-ops on `Booting`, `Reloading`, and `ShuttingDown`.
 *
 * Tests can stub out `startBridge` and `probeHealthz` via the optional
 * second arg; production callers (the bin) pass nothing.
 */
export interface RunBridgeProcessOverrides {
  readonly start?: (config: BridgeConfig) => Promise<RunningBridge>;
  readonly probe?: (publicUrl: string) => Promise<boolean>;
  /**
   * Test-injectable lifecycle factory. Production callers omit this
   * and the default `installBridgeProcessLifecycle` is used (which
   * installs handlers against the real `process` and calls
   * `process.exit` for shutdown).
   */
  readonly installLifecycle?: typeof installBridgeProcessLifecycle;
}

export async function runBridgeProcess(
  env: NodeJS.ProcessEnv = process.env,
  overrides: RunBridgeProcessOverrides = {},
): Promise<void> {
  const start = overrides.start ?? startBridge;
  const probe = overrides.probe ?? probeHealthz;
  const installLifecycle =
    overrides.installLifecycle ?? installBridgeProcessLifecycle;

  // Race-1 fix: install signal handlers BEFORE any boot I/O.
  const lifecycle = installLifecycle({
    env,
    probe,
    process,
    exit: ((code: number) => process.exit(code)) as (code: number) => never,
    logger: log,
  });

  // Skip the reachability probe on initial load — the bridge isn't running yet
  // so /healthz isn't open. We boot first, then probe the live endpoint below.
  const initialInputs = await loadBridgeInputs(env, env.ZAPBOT_CONFIG, async () => true);
  if (initialInputs._tag === "Err") {
    console.error(`[bridge] ${initialInputs.error.reason}`);
    await lifecycle.requestShutdown({
      _tag: "BootConfigInvalid",
      reason: initialInputs.error.reason,
    });
    return;
  }

  if (lifecycle.state()._tag === "ShuttingDown") {
    await lifecycle.requestShutdown({ _tag: "Signal", signal: "SIGTERM" });
    return;
  }

  const initialConfig = buildBridgeConfig(env, initialInputs.value);
  if (initialConfig._tag === "Err") {
    console.error(`[bridge] ${initialConfig.error.reason}`);
    await lifecycle.requestShutdown({
      _tag: "BootConfigInvalid",
      reason: initialConfig.error.reason,
    });
    return;
  }

  if (lifecycle.state()._tag === "ShuttingDown") {
    await lifecycle.requestShutdown({ _tag: "Signal", signal: "SIGTERM" });
    return;
  }

  const cfg = initialConfig.value;
  log.info(`Webhook bridge starting on port ${cfg.port}`);
  log.info(`Ingress mode: ${cfg.ingress.mode}`);

  const running = await start(cfg);

  if (lifecycle.state()._tag === "ShuttingDown") {
    // Signal arrived during start(). Hand `running` to the lifecycle —
    // markReady stashes it even when state is ShuttingDown so the
    // signal-driven shutdown path can stop it gracefully.
    lifecycle.markReady(running, initialInputs.value);
    await lifecycle.requestShutdown({ _tag: "Signal", signal: "SIGTERM" });
    return;
  }

  // Post-boot reachability probe — fires against the now-live /healthz endpoint.
  // Failure is non-fatal: hairpin-NAT / split-horizon DNS deployments cannot
  // reach their own external URL from inside the container.
  if (cfg.ingress.mode === "github-demo" && cfg.publicUrl !== null) {
    const reachable = await probe(cfg.publicUrl);
    if (!reachable) {
      log.warn(`boot_probe_unreachable url="${cfg.publicUrl}" — continuing (hairpin-NAT safe)`);
    }
  }

  // Race-1 corner case (codex review P1): a signal arriving DURING the
  // post-boot probe (when the probe returns true) flips state to
  // ShuttingDown without the boot caller noticing. Without this check,
  // markReady would stash `running` + auto-fire startShutdown but
  // runBridgeProcess would return before the shutdown promise resolved,
  // and the boot caller would not log "listening". Stop the bridge
  // explicitly so the operator sees a clean shutdown trace.
  if (lifecycle.state()._tag === "ShuttingDown") {
    lifecycle.markReady(running, initialInputs.value);
    await lifecycle.requestShutdown({ _tag: "Signal", signal: "SIGTERM" });
    return;
  }

  log.info(`Webhook bridge listening on ${cfg.ingress.mode === "github-demo" ? cfg.publicUrl : "local-only ingress"}`);

  // Hand off ownership: the lifecycle now drives reload + shutdown.
  lifecycle.markReady(running, initialInputs.value);
}
