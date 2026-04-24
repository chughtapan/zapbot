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
 * sender set fails with `KeyDisallowedForRole` at the zapbot seam. OQ #3
 * rejects client-side RECEIVE gates.
 */

import { Effect } from "effect";
import {
  MoltZapApp,
  type AppSessionHandle,
  type Message,
  type Part,
  type WsClientLogger,
} from "@moltzap/app-sdk";
import type { SessionRole } from "./session-role.ts";
import { isWorkerRole } from "./session-role.ts";
import type { ConversationKey } from "./conversation-keys.ts";
import {
  receivableKeysForRole,
  sendableKeysForRole,
} from "./conversation-keys.ts";
import {
  buildOrchestratorManifest,
  buildWorkerManifest,
  expectedKeysForRole,
  loadAppIdentity,
  verifyManifestKeys,
  ZAPBOT_APP_ID,
} from "./manifest.ts";
import type {
  MoltzapConversationId,
  MoltzapSenderId,
} from "./types.ts";
import { asMoltzapConversationId } from "./types.ts";

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
  /**
   * Override env for identity decode (tests). Defaults to `process.env`.
   */
  readonly env?: Record<string, string | undefined>;
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

// ── Invariant 1 singleton ───────────────────────────────────────────

let __singleton: ZapbotMoltZapAppHandle | null = null;
const __handlersRegistered = new Set<ConversationKey>();

/**
 * Boot the single `MoltZapApp` for this process. Calls
 *   1. `loadAppIdentity`,
 *   2. `buildOrchestratorManifest` or `buildWorkerManifest` per `role`,
 *   3. `verifyManifestKeys` against the role's expected keys,
 *   4. `new MoltZapApp({...}).start()`.
 *
 * Invariant 1: a second call to `bootApp` in the same process returns
 * `AppBootAlreadyBooted` without connecting.
 */
export function bootApp(
  config: AppBootConfig,
): Effect.Effect<ZapbotMoltZapAppHandle, AppBootError> {
  if (__singleton !== null) {
    return Effect.fail<AppBootError>({ _tag: "AppBootAlreadyBooted" });
  }
  const env = config.env ?? process.env;
  const identityResult = loadAppIdentity(env);
  if ("_tag" in identityResult) {
    return Effect.fail<AppBootError>({
      _tag: "AppBootManifestInvalid",
      reason: identityResult.reason,
    });
  }
  const identity = identityResult;
  const manifest =
    config.role === "orchestrator"
      ? buildOrchestratorManifest(identity)
      : buildWorkerManifest(identity, config.role);
  const mismatch = verifyManifestKeys(
    manifest,
    expectedKeysForRole(config.role),
  );
  if (mismatch !== null) {
    return Effect.fail<AppBootError>({
      _tag: "AppBootManifestInvalid",
      reason: `manifest keys mismatch: expected=${JSON.stringify(
        mismatch.expected,
      )} declared=${JSON.stringify(mismatch.declared)}`,
    });
  }
  // Worker roles never carry invitedAgentIds: only the session
  // initiator (bridge) invites others at apps/create time.
  const invitedAgentIds = isWorkerRole(config.role)
    ? []
    : (config.invitedAgentIds ?? []).map((s) => s as unknown as string);

  const app = new MoltZapApp({
    serverUrl: config.serverUrl,
    agentKey: config.agentKey,
    manifest,
    logger: config.logger,
    invitedAgentIds,
  });

  return app.start().pipe(
    Effect.mapError<unknown, AppBootError>((e) => {
      const cause = e instanceof Error ? e.message : String(e);
      const tag = e instanceof Error ? e.name : "unknown";
      if (tag === "AuthError") {
        return { _tag: "AppBootConnectFailed", cause };
      }
      if (tag === "ManifestRegistrationError") {
        return { _tag: "AppBootManifestInvalid", reason: cause };
      }
      return { _tag: "AppBootSessionFailed", cause };
    }),
    Effect.map((session: AppSessionHandle) => {
      const handle: ZapbotMoltZapAppHandle = {
        role: config.role,
        __unsafeInner: app,
        session,
      };
      __singleton = handle;
      __handlersRegistered.clear();
      return handle;
    }),
  );
}

/** Return the booted app handle, or `null` if `bootApp` has not run. */
export function currentApp(): ZapbotMoltZapAppHandle | null {
  return __singleton;
}

/**
 * Stop and tear down the booted app. Invariant 1 enforcement on graceful
 * shutdown: drains the app then clears the singleton so a subsequent
 * `bootApp` is allowed.
 */
export function shutdownApp(): Effect.Effect<void, never> {
  const h = __singleton;
  if (h === null) return Effect.succeed(undefined);
  __singleton = null;
  __handlersRegistered.clear();
  return h.__unsafeInner.stop();
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
  const permitted = sendableKeysForRole(handle.role);
  if (!permitted.has(key)) {
    return Effect.fail<SendErrorChannel>({
      _tag: "KeyDisallowedForRole",
      role: handle.role,
      key,
    });
  }
  const resolved = resolveKeyToConversationId(handle, key);
  if (typeof resolved !== "string") {
    return Effect.fail<SendErrorChannel>(resolved);
  }
  return handle.__unsafeInner
    .sendTo(resolved as unknown as string, parts as Part[])
    .pipe(
      Effect.mapError<unknown, SendErrorChannel>((e) => ({
        _tag: "SendRpcFailed",
        cause: e instanceof Error ? e.message : String(e),
      })),
    );
}

/**
 * Register a handler for inbound messages on `key`. Gated by
 * `receivableKeysForRole`: a worker cannot register a handler on a key its
 * role does not receive.
 *
 * NOTE (Invariant 6): the receiver trusts the key. This function does NOT
 * inspect `message.senderId` or a role field in the body.
 */
export function onMessageForKey(
  handle: ZapbotMoltZapAppHandle,
  key: ConversationKey,
  handler: MessageHandler,
): HandlerRegistrationError | null {
  const permitted = receivableKeysForRole(handle.role);
  if (!permitted.has(key)) {
    return {
      _tag: "KeyNotReceivableForRole",
      role: handle.role,
      key,
    };
  }
  if (__handlersRegistered.has(key)) {
    return {
      _tag: "HandlerAlreadyRegistered",
      key,
    };
  }
  handle.__unsafeInner.onMessage(key, handler);
  __handlersRegistered.add(key);
  return null;
}

/** Register a session-ready handler. Thin pass-through to `MoltZapApp`. */
export function onSessionReady(
  handle: ZapbotMoltZapAppHandle,
  handler: SessionReadyHandler,
): void {
  handle.__unsafeInner.onSessionReady(handler);
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
  const raw = handle.session.conversations[key];
  if (typeof raw !== "string" || raw.length === 0) {
    return { _tag: "KeyNotInSession", key };
  }
  return asMoltzapConversationId(raw);
}

// Test-only hook: reset the singleton between test runs. NOT part of the
// public boot surface — Invariant 1 still holds in production.
export function __resetAppSingletonForTests(): void {
  __singleton = null;
  __handlersRegistered.clear();
}

// Re-export ZAPBOT_APP_ID for callers that need to reference the constant
// without pulling manifest.ts directly.
export { ZAPBOT_APP_ID };
