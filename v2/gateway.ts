/**
 * v2/gateway — the bridge's view of the gateway service.
 *
 * Two responsibilities:
 *   1. Register/deregister/heartbeat with the gateway service.
 *   2. Verify HMAC on a forwarded webhook envelope and classify it
 *      into a `ClassifiedWebhook` the bridge can act on.
 */

import { verifySignature } from "../src/http/verify-signature.ts";
import { parseMention } from "./mention-parser.ts";
import {
  asCommentId,
  asIssueNumber,
  err,
  ok,
} from "./types.ts";
import type {
  BotUsername,
  CommentId,
  DeliveryId,
  GatewayError,
  IssueNumber,
  MentionCommand,
  RepoFullName,
  Result,
  WebhookIntakeError,
} from "./types.ts";

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
  | {
      readonly kind: "mention_command";
      readonly repo: RepoFullName;
      readonly issue: IssueNumber;
      readonly commentId: CommentId;
      readonly command: MentionCommand;
      readonly triggeredBy: string;
    };

/**
 * Verify HMAC, then classify the envelope into either `ignore` or a
 * `mention_command`. Only `issue_comment.created` events whose body mentions
 * the bot can become `mention_command`; everything else resolves to `ignore`.
 */
export async function verifyAndClassify(
  envelope: GatewayWebhookEnvelope,
  resolveSecret: (repo: RepoFullName) => string | null,
  botUsername: BotUsername
): Promise<Result<ClassifiedWebhook, WebhookIntakeError>> {
  const secret = resolveSecret(envelope.repo);
  if (secret === null) return err({ _tag: "SecretMissing", repo: envelope.repo });
  const verified = await verifySignature(envelope.rawBody, envelope.signature, secret);
  if (!verified) return err({ _tag: "SignatureMismatch" });

  const p = envelope.payload as {
    action?: string;
    comment?: { id?: number; body?: string };
    issue?: { number?: number; pull_request?: unknown };
    sender?: { login?: string };
  } | null;

  if (!p || typeof p !== "object") {
    return ok({ kind: "ignore", reason: "payload not an object" });
  }

  if (envelope.eventType !== "issue_comment" || p.action !== "created") {
    return ok({ kind: "ignore", reason: `event ${envelope.eventType}.${p.action ?? "?"}` });
  }

  const actor = p.sender?.login ?? "";
  if (actor === (botUsername as unknown as string)) {
    return ok({ kind: "ignore", reason: "self-mention" });
  }

  const issueNum = p.issue?.number;
  const commentId = p.comment?.id;
  const commentBody = p.comment?.body ?? "";
  if (typeof issueNum !== "number" || typeof commentId !== "number") {
    return ok({ kind: "ignore", reason: "missing issue/comment id" });
  }

  const command = parseMention(commentBody, botUsername);
  if (command === null) {
    return ok({ kind: "ignore", reason: "no bot mention" });
  }

  return ok({
    kind: "mention_command",
    repo: envelope.repo,
    issue: asIssueNumber(issueNum),
    commentId: asCommentId(commentId),
    command,
    triggeredBy: actor,
  });
}
