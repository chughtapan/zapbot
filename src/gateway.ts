/**
 * gateway — the bridge's view of the gateway service.
 *
 * Two responsibilities:
 *   1. Register/deregister/heartbeat with the gateway service.
 *   2. Verify HMAC on a forwarded webhook envelope and classify it
 *      into a `ClassifiedWebhook` the bridge can act on.
 */

import { verifySignature } from "./http/verify-signature.ts";
import { buildEligibleMentionRequest, type EligibleMentionRequest } from "./github-control-request.ts";
import {
  asCommentId,
  asIssueNumber,
  err,
  ok,
  type ProjectName,
} from "./types.ts";
import type {
  BotUsername,
  DeliveryId,
  GatewayError,
  RepoFullName,
  Result,
  WebhookIntakeError,
} from "./types.ts";
import { detectEligibleBotMention } from "./mention-detection.ts";

// ── Bridge → gateway registration ───────────────────────────────────

export interface GatewayClientConfig {
  readonly gatewayUrl: string;
  readonly secret: string | null;
  readonly token: string | null;
}

function authToken(config: GatewayClientConfig): string | null {
  return config.token ?? config.secret ?? null;
}

async function postRegistration(
  config: GatewayClientConfig,
  method: "POST" | "DELETE",
  body: Record<string, unknown>
): Promise<Result<void, GatewayError>> {
  const token = authToken(config);
  if (!token) return err({ _tag: "GatewayAuthMissing" });
  const url = `${config.gatewayUrl}/api/bridges/register`;
  try {
    const resp = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return err({ _tag: "GatewayRejected", status: resp.status, body: text });
    }
    return ok(undefined);
  } catch (e) {
    return err({ _tag: "GatewayUnreachable", cause: String(e) });
  }
}

/**
 * Register this bridge with the gateway for the given repo. Idempotent:
 * re-registering overwrites the previous `bridgeUrl` mapping.
 */
export function registerBridge(
  config: GatewayClientConfig,
  repo: RepoFullName,
  bridgeUrl: string
): Promise<Result<void, GatewayError>> {
  return postRegistration(config, "POST", { repo, bridgeUrl });
}

export function deregisterBridge(
  config: GatewayClientConfig,
  repo: RepoFullName,
  _bridgeUrl: string
): Promise<Result<void, GatewayError>> {
  return postRegistration(config, "DELETE", { repo });
}

/**
 * Start a periodic re-registration loop. Returns a disposer that stops the
 * loop.
 */
export function startHeartbeat(
  config: GatewayClientConfig,
  repos: ReadonlyArray<RepoFullName>,
  bridgeUrl: string,
  intervalMs: number
): () => void {
  const timer = setInterval(() => {
    for (const repo of repos) {
      // Fire-and-forget; gateway tolerates duplicate registrations.
      void registerBridge(config, repo, bridgeUrl);
    }
  }, intervalMs);
  return () => clearInterval(timer);
}

// ── Webhook intake contract ─────────────────────────────────────────

export interface GatewayWebhookEnvelope {
  readonly rawBody: string;
  readonly signature: string | null;
  readonly eventType: string;
  readonly deliveryId: DeliveryId;
  readonly repo: RepoFullName;
  readonly payload: unknown;
}

export type ClassifiedWebhook =
  | { readonly kind: "ignore"; readonly reason: string }
  | { readonly kind: "mention_request"; readonly request: EligibleMentionRequest };

// ── Boundary schema: issue_comment payload ──────────────────────────

interface IssueCommentPayload {
  readonly action: string;
  readonly comment: { readonly id: number; readonly body: string; readonly htmlUrl: string | null };
  readonly issue: {
    readonly number: number;
    readonly isPullRequest: boolean;
    readonly title: string | null;
    readonly htmlUrl: string | null;
  };
  readonly sender: { readonly login: string };
}

interface JsonObject {
  readonly [key: string]: unknown;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

type DecodeResult =
  | { readonly kind: "decoded"; readonly value: IssueCommentPayload }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "other_event"; readonly reason: string };

/**
 * Validate the shape of an issue_comment webhook payload. Returns `decoded`
 * on success, `other_event` when the payload is structurally valid JSON that
 * isn't an issue_comment we care about (→ caller should ignore), or `invalid`
 * when the shape is wrong (→ caller should reject).
 */
function decodeIssueCommentPayload(
  payload: unknown,
  eventType: string
): DecodeResult {
  if (!isJsonObject(payload)) {
    return { kind: "invalid", reason: "payload is not an object" };
  }
  if (eventType !== "issue_comment") {
    return { kind: "other_event", reason: `event ${eventType}` };
  }
  const action = payload.action;
  if (!isString(action)) {
    return { kind: "invalid", reason: "missing string 'action'" };
  }
  if (action !== "created") {
    return { kind: "other_event", reason: `action ${action}` };
  }

  const comment = payload.comment;
  if (!isJsonObject(comment)) {
    return { kind: "invalid", reason: "missing 'comment' object" };
  }
  if (!isNumber(comment.id) || !isString(comment.body)) {
    return { kind: "invalid", reason: "comment.id/body malformed" };
  }
  if (comment.html_url !== undefined && comment.html_url !== null && !isString(comment.html_url)) {
    return { kind: "invalid", reason: "comment.html_url malformed" };
  }

  const issue = payload.issue;
  if (!isJsonObject(issue)) {
    return { kind: "invalid", reason: "missing 'issue' object" };
  }
  if (!isNumber(issue.number)) {
    return { kind: "invalid", reason: "issue.number malformed" };
  }
  if (issue.title !== undefined && issue.title !== null && !isString(issue.title)) {
    return { kind: "invalid", reason: "issue.title malformed" };
  }
  if (issue.html_url !== undefined && issue.html_url !== null && !isString(issue.html_url)) {
    return { kind: "invalid", reason: "issue.html_url malformed" };
  }

  const sender = payload.sender;
  if (!isJsonObject(sender)) {
    return { kind: "invalid", reason: "missing 'sender' object" };
  }
  if (!isString(sender.login)) {
    return { kind: "invalid", reason: "sender.login malformed" };
  }

  return {
    kind: "decoded",
    value: {
      action,
      comment: {
        id: comment.id,
        body: comment.body,
        htmlUrl: isString(comment.html_url) ? comment.html_url : null,
      },
      issue: {
        number: issue.number,
        isPullRequest: issue.pull_request !== undefined && issue.pull_request !== null,
        title: isString(issue.title) ? issue.title : null,
        htmlUrl: isString(issue.html_url) ? issue.html_url : null,
      },
      sender: { login: sender.login },
    },
  };
}

/**
 * Verify HMAC, then classify the envelope into either `ignore` or a
 * `mention_request`. The gateway owns eligibility and placement shaping; AO
 * owns interpretation of the raw message body.
 */
export async function verifyAndClassify(
  envelope: GatewayWebhookEnvelope,
  resolveSecret: (repo: RepoFullName) => string | null,
  resolveProjectName: (repo: RepoFullName) => ProjectName | null,
  botUsername: BotUsername
): Promise<Result<ClassifiedWebhook, WebhookIntakeError>> {
  const secret = resolveSecret(envelope.repo);
  if (secret === null) return err({ _tag: "SecretMissing", repo: envelope.repo });
  const verified = await verifySignature(envelope.rawBody, envelope.signature, secret);
  if (!verified) return err({ _tag: "SignatureMismatch" });

  const decoded = decodeIssueCommentPayload(envelope.payload, envelope.eventType);
  if (decoded.kind === "invalid") {
    return err({ _tag: "PayloadShapeInvalid", reason: decoded.reason });
  }
  if (decoded.kind === "other_event") {
    return ok({ kind: "ignore", reason: decoded.reason });
  }

  const p = decoded.value;
  if (p.sender.login === (botUsername as unknown as string)) {
    return ok({ kind: "ignore", reason: "self-mention" });
  }

  const mention = detectEligibleBotMention(p.comment.body, botUsername);
  if (mention._tag === "Err") {
    return err({ _tag: "PayloadShapeInvalid", reason: mention.error.reason });
  }
  if (mention.value === null) {
    return ok({ kind: "ignore", reason: "no bot mention" });
  }
  const projectName = resolveProjectName(envelope.repo);
  if (projectName === null) {
    return err({ _tag: "ProjectNotConfigured", repo: envelope.repo });
  }
  const request = buildEligibleMentionRequest({
    placement: {
      repo: envelope.repo,
      projectName,
      issue: asIssueNumber(p.issue.number),
      issueThreadKind: p.issue.isPullRequest ? "pull_request" : "issue",
      issueTitle: p.issue.title,
      issueUrl: p.issue.htmlUrl,
      commentId: asCommentId(p.comment.id),
      commentUrl: p.comment.htmlUrl,
      deliveryId: envelope.deliveryId,
    },
    rawCommentBody: p.comment.body,
    triggeredBy: p.sender.login,
  });
  if (request._tag === "Err") {
    return err({ _tag: "PayloadShapeInvalid", reason: request.error.reason });
  }

  return ok({
    kind: "mention_request",
    request: request.value,
  });
}
