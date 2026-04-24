/**
 * moltzap/app-client — zapbot-scoped wrapper around `@moltzap/app-sdk`'s
 * `MoltZapApp`.
 *
 * Anchors: sbd#170 SPEC rev 2, Invariants 1, 2, 6, 7, 8; §5 `MoltZapApp` and
 * `app.onMessage` / `app.send` bullets; OQ #4 (one manifest per role); OQ #3
 * (per-role-pair keys, no receive-side defensive check).
 *
 * This module is the single construction point for `MoltZapApp` in zapbot.
 * Invariant 1 ("one `MoltZapApp` per process") is enforced here: `bootApp`
 * returns the singleton; `currentApp` reads it; repeated `bootApp` calls
 * error.
 *
 * Send-time role gate: zapbot constrains `app.send(key, parts)` to the keys
 * `sendableKeysForRole(role)` permits. The check runs BEFORE the RPC is
 * dispatched, so a worker that attempts to post on a key outside its role's
 * sender set fails with `KeyDisallowedForRole` at the zapbot seam. This is
 * the only role-pair check zapbot layers on top of the server; OQ #3 rejects
 * client-side RECEIVE gates.
 *
 * Architect stage — bodies throw.
 */

import type { Effect } from "effect";
import type {
  AppSessionHandle,
  MoltZapApp,
  Part,
  Message,
  WsClientLogger,
} from "@moltzap/app-sdk";
import type { SessionRole } from "./session-role.ts";
import type { ConversationKey } from "./conversation-keys.ts";
import type {
  MoltzapSenderId,
  MoltzapConversationId,
} from "./types.ts";

// ── Boot config ─────────────────────────────────────────────────────

export interface AppBootConfig {
  readonly serverUrl: string;
  /** The agentKey minted for this process (orchestrator or worker). */
  readonly agentKey: string;
  readonly role: SessionRole;
  readonly logger?: WsClientLogger;
  /**
   * For the bridge/orchestrator path, the senderIds of every roster worker
   * to invite at session-create time. Maps to `app.createSession({
   * invitedAgentIds })` in the initial `start()` call. Ignored for worker
   * roles (workers join an existing session driven by the bridge).
   */
  readonly invitedAgentIds?: readonly MoltzapSenderId[];
}

export type AppBootError =
  | { readonly _tag: "AppBootAlreadyBooted" }
  | { readonly _tag: "AppBootManifestInvalid"; readonly reason: string }
  | {
      readonly _tag: "AppBootConnectFailed";
      readonly cause: string;
    }
  | {
      readonly _tag: "AppBootSessionFailed";
      readonly cause: string;
    };

// ── Send / receive errors ───────────────────────────────────────────

export type SendErrorChannel =
  | { readonly _tag: "KeyDisallowedForRole"; readonly role: SessionRole; readonly key: ConversationKey }
  | { readonly _tag: "NoActiveSession" }
  | { readonly _tag: "KeyNotInSession"; readonly key: ConversationKey }
  | { readonly _tag: "SendRpcFailed"; readonly cause: string };

export type HandlerRegistrationError =
  | { readonly _tag: "KeyNotReceivableForRole"; readonly role: SessionRole; readonly key: ConversationKey }
  | { readonly _tag: "HandlerAlreadyRegistered"; readonly key: ConversationKey };

// ── Handle + public surface ─────────────────────────────────────────

/**
 * Opaque handle returned by `bootApp`. Narrow surface; wraps `MoltZapApp`
 * rather than re-exporting it so Invariant 1 ("one MoltZapApp per process")
 * stays enforced — consumers cannot construct a second `MoltZapApp` by
 * reaching into the handle.
 */
export interface ZapbotMoltZapAppHandle {
  readonly role: SessionRole;
  /** Escape hatch for tests only. */
  readonly __unsafeInner: MoltZapApp;
  /** Awaited once the initial `app.start()` resolves. */
  readonly session: AppSessionHandle;
}

export type MessageHandler = (message: Message) => void | Promise<void>;
export type SessionReadyHandler = (
  session: AppSessionHandle,
) => void | Promise<void>;

/**
 * Boot the single `MoltZapApp` for this process. Calls
 *   1. `loadAppIdentity` (manifest.ts),
 *   2. `buildOrchestratorManifest` or `buildWorkerManifest` per `role`,
 *   3. `verifyManifestKeys` against the role's expected keys,
 *   4. `new MoltZapApp({...}).startAsync()`.
 *
 * Invariant 1: a second call to `bootApp` in the same process returns
 * `AppBootAlreadyBooted` without connecting.
 */
export function bootApp(
  config: AppBootConfig,
): Effect.Effect<ZapbotMoltZapAppHandle, AppBootError> {
  throw new Error("not implemented");
}

/** Return the booted app handle, or `null` if `bootApp` has not run. */
export function currentApp(): ZapbotMoltZapAppHandle | null {
  throw new Error("not implemented");
}

/**
 * Stop and tear down the booted app. Invariant 1 enforcement on graceful
 * shutdown: drains the app then clears the singleton so a subsequent
 * `bootApp` is allowed.
 */
export function shutdownApp(): Effect.Effect<void, never> {
  throw new Error("not implemented");
}

// ── Messaging ───────────────────────────────────────────────────────

/**
 * Send `parts` to the conversation named by `key`. Runs the role gate
 * (`sendableKeysForRole`) BEFORE dispatching the RPC. OQ #3 tie: the gate is
 * on the SEND side only; no receive-side gate.
 */
export function sendOnKey(
  handle: ZapbotMoltZapAppHandle,
  key: ConversationKey,
  parts: readonly Part[],
): Effect.Effect<void, SendErrorChannel> {
  throw new Error("not implemented");
}

/**
 * Register a handler for inbound messages on `key`. Gated by
 * `receivableKeysForRole`: a worker cannot register a handler on a key its
 * role does not receive.
 *
 * NOTE (Invariant 6): the receiver trusts the key. This function does NOT
 * inspect `message.senderId` or a role field in the body. The SEND-side
 * role gate + role-scoped manifest declare what messages can appear on a
 * given key; the receiver acts on the key alone.
 */
export function onMessageForKey(
  handle: ZapbotMoltZapAppHandle,
  key: ConversationKey,
  handler: MessageHandler,
): HandlerRegistrationError | null {
  throw new Error("not implemented");
}

/** Register a session-ready handler. Thin pass-through to `MoltZapApp`. */
export function onSessionReady(
  handle: ZapbotMoltZapAppHandle,
  handler: SessionReadyHandler,
): void {
  throw new Error("not implemented");
}

// ── Conversation-id resolution ──────────────────────────────────────

/**
 * Resolve a typed key to the live `conversationId` in the current session.
 * Used by callers that must hand a raw id to a non-sdk path (e.g., the
 * `conversations/addParticipant` roster-admit path in `roster-admit.ts`).
 */
export function resolveKeyToConversationId(
  handle: ZapbotMoltZapAppHandle,
  key: ConversationKey,
): MoltzapConversationId | { readonly _tag: "KeyNotInSession"; readonly key: ConversationKey } {
  throw new Error("not implemented");
}
