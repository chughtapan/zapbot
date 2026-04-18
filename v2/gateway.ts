/**
 * v2/gateway — the bridge's view of the gateway service.
 *
 * The gateway itself (the static-URL Bun HTTP proxy under `gateway/`) is
 * unchanged in v2 and stays out of this module. This file defines the
 * bridge-side client surface: register on boot, deregister on shutdown,
 * heartbeat while alive. It also exports the webhook intake contract that
 * the bridge uses when the gateway forwards an event.
 *
 * Principle 3 (typed errors): every call returns `Result<T, GatewayError>`.
 * No raw `throw`. Callers pattern-match on `_tag`.
 */

import type {
  BotUsername,
  DeliveryId,
  GatewayError,
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

/**
 * Register this bridge with the gateway for the given repo. Idempotent:
 * re-registering overwrites the previous `bridgeUrl` mapping.
 */
export function registerBridge(
  _config: GatewayClientConfig,
  _repo: RepoFullName,
  _bridgeUrl: string
): Promise<Result<void, GatewayError>> {
  throw new Error("not implemented");
}

export function deregisterBridge(
  _config: GatewayClientConfig,
  _repo: RepoFullName,
  _bridgeUrl: string
): Promise<Result<void, GatewayError>> {
  throw new Error("not implemented");
}

/**
 * Start a periodic re-registration loop. Returns a disposer that stops the
 * loop. Exactly-once semantics are not guaranteed across restarts; the
 * gateway is expected to tolerate duplicate registrations.
 */
export function startHeartbeat(
  _config: GatewayClientConfig,
  _repos: ReadonlyArray<RepoFullName>,
  _bridgeUrl: string,
  _intervalMs: number
): () => void {
  throw new Error("not implemented");
}

// ── Webhook intake contract ─────────────────────────────────────────

/**
 * Shape handed to the bridge once the gateway has forwarded a GitHub webhook.
 * The body is the raw string used for HMAC; the parsed payload is the
 * decoded JSON the bridge reads for routing.
 */
export interface GatewayWebhookEnvelope {
  readonly rawBody: string;
  readonly signature: string | null;
  readonly eventType: string;
  readonly deliveryId: DeliveryId;
  readonly repo: RepoFullName;
  readonly payload: unknown;
}

/**
 * Verify HMAC against the per-repo secret, decode the bot-relevant command
 * (if any), and return the bridge's next-action intent. Pure over the
 * envelope plus a secret resolver; no I/O beyond crypto.
 *
 * Downstream dispatch is not this module's concern — `v2/bridge.ts` owns
 * that. This function's job is to make the webhook safe to act on.
 */
export function verifyAndClassify(
  _envelope: GatewayWebhookEnvelope,
  _resolveSecret: (repo: RepoFullName) => string | null,
  _botUsername: BotUsername
): Promise<Result<ClassifiedWebhook, WebhookIntakeError>> {
  throw new Error("not implemented");
}

/**
 * What the bridge does next, named at the interface so each variant is
 * exhaustive in the bridge's switch.
 */
export type ClassifiedWebhook =
  | { readonly kind: "ignore"; readonly reason: string }
  | {
      readonly kind: "mention_command";
      readonly repo: RepoFullName;
      readonly issue: import("./types.ts").IssueNumber;
      readonly commentId: import("./types.ts").CommentId;
      readonly command: import("./types.ts").MentionCommand;
      readonly triggeredBy: string;
    };
