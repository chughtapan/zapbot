/**
 * moltzap/bridge-app — bridge-process MoltZapApp lifecycle.
 *
 * Anchors: sbd#199 acceptance items 1, 2, 3, 7 (bridge identity boot
 * sequence per A+C(2)), 8 (zapbot#336 path b), 9 (moltzap#230
 * operational posture).
 *
 * **Boot sequence (A+C(2), in order):**
 *   1. `loadBridgeIdentityEnv(env)` — decode env (Principle 2 boundary).
 *   2. `registerBridgeAgent({ serverUrl, registrationSecret, ... })` —
 *      `POST /api/v1/auth/register` against the upstream MoltZap server.
 *      On success: `BridgeIdentity { agentId, agentKey, displayName }`.
 *      No persistence — every boot mints a fresh agent (rev 2.1, codex
 *      P1 fold; see `bridge-identity.ts` header).
 *   3. `new MoltZapApp({ serverUrl, agentKey, manifest: buildUnionManifest(identity) })`.
 *      `manifest` satisfies `MoltZapAppOptions` (`~/moltzap/packages/app-sdk/src/app.ts:8-20`).
 *   4. `app.start()` — internally connects WS (sends `auth/connect` with
 *      `agentKey`), calls `apps/register` with the union manifest, and
 *      ALSO calls `apps/create` with no `invitedAgentIds` (SDK seed
 *      session). The seed session is held by the SDK; per-spawn
 *      sessions are created on demand via `createBridgeSession` below.
 *   5. Singleton recorded in `__bridgeSingleton`. `bridgeAgentId()` is
 *      now non-null.
 *
 * **Lifetime.** Exactly one `MoltZapApp` per bridge process. Constructed
 * once at boot; torn down once at SIGTERM. Heartbeat + reconnect are
 * SDK-managed (see `~/moltzap/packages/app-sdk/src/app.ts:174-181`,
 * `587-604`).
 *
 * **SIGHUP policy.** `bridge-app.ts` is NOT touched by SIGHUP. The
 * SIGHUP reload path in `bin/webhook-bridge.ts:229` reloads bridge
 * config (allowlist, repo set, secret rotation) without tearing down
 * the WS or active sessions. Implementation note: `reloadBridge` MUST
 * NOT call `shutdownBridgeApp`. The registration secret rotation takes
 * effect on next process restart cleanly because v1 mints a fresh
 * agent on every boot (no stale-persisted-key class).
 *
 * **Silence invariant (A+C(2) — bridge silent at app layer).** This
 * module deliberately omits any `send`, `sendOnKey`, `sendTo`, or
 * `reply` export. `BridgeAppHandle` exposes only the read-only
 * `onBridgeMessage` and the privileged `agentId`. Bridge code that
 * needs to OBSERVE inbound traffic uses `onBridgeMessage(key, handler)`
 * — read-only.
 *
 * **Credential-handling note (codex P2 fold).** `BridgeAppHandle` does
 * NOT carry the full `BridgeIdentity` (which contains the privileged
 * `agentKey`). Only the public `agentId` (branded, non-credential) is
 * exposed. The `agentKey` lives module-locally inside the wrapped
 * `MoltZapApp`; it is not re-exposed on the handle.
 *
 * **Session ownership.** The bridge is the session initiator
 * (`apps/create` caller). It holds `apps/closeSession` privilege per
 * upstream `app-host.ts:803` invariant. moltzap#230 (initiator-death
 * leak) is accepted for v1 — see §"Operational posture" in the design
 * doc.
 */

import { Effect } from "effect";
import type { Message, WsClientLogger } from "@moltzap/app-sdk";
import {
  AuthError,
  ManifestRegistrationError,
  SessionError,
} from "@moltzap/app-sdk";
import type { ConversationKey } from "./conversation-keys.ts";
import type {
  BridgeAgentId,
  BridgeRegistrationError,
} from "./bridge-identity.ts";
import type { MoltzapSenderId } from "./types.ts";

// ── Boot config + errors ────────────────────────────────────────────

export interface BridgeAppBootConfig {
  readonly serverUrl: string;
  readonly env?: Record<string, string | undefined>;
  readonly logger?: WsClientLogger;
}

/**
 * Boot error channel. Preserves SDK error class instances (codex P1 fold,
 * Principle 3): `AuthError`, `ManifestRegistrationError`, `SessionError`
 * are class instances with `code`, `message`, `cause`, and `stack`. Do
 * NOT narrow these to `cause: string` — operators distinguish "auth key
 * rejected" vs "WS transport failure" vs "manifest registration
 * conflict" by the discriminator class.
 */
export type BridgeAppBootError =
  | { readonly _tag: "BridgeAppAlreadyBooted" }
  | {
      readonly _tag: "BridgeAppRegistrationFailed";
      readonly cause: BridgeRegistrationError;
    }
  | {
      readonly _tag: "BridgeAppManifestInvalid";
      readonly cause: ManifestRegistrationError;
    }
  | {
      readonly _tag: "BridgeAppConnectFailed";
      readonly cause: AuthError;
    }
  | {
      readonly _tag: "BridgeAppSessionFailed";
      readonly cause: SessionError;
    };

// ── Public handle ───────────────────────────────────────────────────

/**
 * Opaque handle returned by `bootBridgeApp`. Notably absent: any send
 * surface AND the privileged `agentKey` (codex P2 credential-leak
 * guard). Carries only:
 *   - `agentId`: branded BridgeAgentId for `apps/closeSession`.
 *   - read-only `onBridgeMessage(key, handler)` for observability.
 *   - read-only `listActiveSessions()` for SIGTERM drain enumeration.
 *
 * Per-spawn session creation (`createBridgeSession`) is a module-level
 * function that consults the singleton; it is NOT a handle method
 * (codex P2 fold — accept the module-singleton shape rather than hiding
 * initiator privilege behind a handle method).
 */
export interface BridgeAppHandle {
  readonly agentId: BridgeAgentId;
  /** Display name from the registered identity. Non-credential. */
  readonly displayName: string;
  /**
   * Read-only inbound observation. Returns the handler-registration
   * receipt or a typed error. Bridge code uses this for roster/budget
   * tracking; it does NOT (and cannot) send replies.
   */
  readonly onBridgeMessage: (
    key: ConversationKey,
    handler: (message: Message) => void | Promise<void>,
  ) => BridgeMessageHandlerError | null;
  /**
   * Enumerate the bridge's active per-spawn session ids. Used by
   * `drainBridgeSessions` to know what to close at SIGTERM. Read-only.
   * The session registry is module-local, populated by
   * `createBridgeSession` and pruned by `closeBridgeSession`.
   */
  readonly listActiveSessions: () => readonly string[];
}

export type BridgeMessageHandlerError = {
  readonly _tag: "BridgeHandlerAlreadyRegistered";
  readonly key: ConversationKey;
};

// ── Boot ────────────────────────────────────────────────────────────

/**
 * Boot the bridge's `MoltZapApp` per the A+C(2) boot sequence above.
 *
 * Invariant 1 (one MoltZapApp per bridge process): the second call in
 * the same process fails with `BridgeAppAlreadyBooted` regardless of
 * the first call's resolution state.
 */
export function bootBridgeApp(
  config: BridgeAppBootConfig,
): Effect.Effect<BridgeAppHandle, BridgeAppBootError> {
  throw new Error("not implemented");
}

/** Return the booted bridge handle, or `null` if `bootBridgeApp` has not run. */
export function currentBridgeApp(): BridgeAppHandle | null {
  throw new Error("not implemented");
}

/**
 * Read the bridge's MoltZap agentId. Used by `RosterManager` to seed
 * the orchestrator-side allowlist that previously fell back to the
 * literal `"zapbot-orchestrator"` at `src/bridge.ts:801-803`.
 *
 * Returns `null` if `bootBridgeApp` has not yet resolved. Callers MUST
 * order their boot so this returns non-null before they construct the
 * RosterManager.
 */
export function bridgeAgentId(): BridgeAgentId | null {
  throw new Error("not implemented");
}

/**
 * Tear down the bridge's `MoltZapApp`. Idempotent. Called at SIGTERM
 * AFTER `drainBridgeSessions` resolves. NOT called by SIGHUP reload.
 *
 * Crash-path note: SDK `stop()` (`~/moltzap/packages/app-sdk/src/app.ts:193-219`)
 * unconditionally closes every active session with no timeout. The
 * SIGTERM-drain narrative relies on call ordering — `drainBridgeSessions`
 * BEFORE `shutdownBridgeApp`. If the process exits via Effect defect or
 * hard-kill before the drain runs, the drain budget is bypassed and the
 * leak class falls back to moltzap#230's accepted shape.
 */
export function shutdownBridgeApp(): Effect.Effect<void, never> {
  throw new Error("not implemented");
}

// ── Per-spawn session creation (initiator authority) ────────────────

/**
 * Per-spawn session creation. Wraps SDK's
 * `MoltZapApp.createSession(invitedAgentIds?: string[])` (positional
 * `string[]`; see `~/moltzap/packages/app-sdk/src/app.ts:240-265`). The
 * architect-API named-field shape below maps to the positional call
 * inside the implementation.
 */
export interface BridgeSessionRequest {
  /** SenderIds of every roster member to invite at session-create time. */
  readonly invitedAgentIds: readonly MoltzapSenderId[];
}

export type BridgeSessionError =
  | { readonly _tag: "BridgeAppNotBooted" }
  | {
      readonly _tag: "BridgeSessionCreateFailed";
      readonly cause: SessionError;
    };

/**
 * Create a per-spawn `AppSession` from the bridge's long-lived
 * `MoltZapApp`. Wraps `MoltZapApp.createSession(invitedAgentIds)`
 * (positional). Registers the resulting session id in the module-local
 * active-sessions registry (visible via `BridgeAppHandle.listActiveSessions`).
 *
 * Returned `BridgeSessionHandle` exposes only:
 *   - `sessionId` for opaque routing.
 *   - `conversations` map (typed `ConversationKey` → raw conversationId).
 *   - read-only `onMessage(key, handler)`.
 *
 * Send is not exposed. Worker processes hold their own outbound surface
 * via `worker-channel.ts` (the channel package's MCP `reply` tool); the
 * bridge does not author messages on per-spawn sessions.
 */
export function createBridgeSession(
  request: BridgeSessionRequest,
): Effect.Effect<BridgeSessionHandle, BridgeSessionError> {
  throw new Error("not implemented");
}

export interface BridgeSessionHandle {
  readonly sessionId: string;
  readonly conversations: Readonly<Record<ConversationKey, string>>;
  readonly onMessage: (
    key: ConversationKey,
    handler: (message: Message) => void | Promise<void>,
  ) => BridgeMessageHandlerError | null;
}

// ── Session close (initiator privilege) ─────────────────────────────

export type BridgeCloseSessionError =
  | { readonly _tag: "BridgeAppNotBooted" }
  | {
      readonly _tag: "BridgeCloseSessionFailed";
      readonly cause: SessionError;
    };

/**
 * Close a session by id. Caller must be the bridge (initiator); upstream
 * `app-host.ts:803` enforces this. Removes the session from the
 * module-local active-sessions registry. Used at session end + at
 * bridge SIGTERM drain.
 */
export function closeBridgeSession(
  sessionId: string,
): Effect.Effect<void, BridgeCloseSessionError> {
  throw new Error("not implemented");
}

/**
 * SIGTERM-drain helper: enumerate active sessions held by this bridge
 * process via `BridgeAppHandle.listActiveSessions()` and close each in
 * order. Bounded by `timeoutMs`; on timeout, remaining sessions leak
 * (moltzap#230). Returns the list of leaked sessionIds for telemetry.
 *
 * Operational posture (sbd#199 item 9): v1 accepts the bridge-restart
 * leak class. This drain reduces the leak rate; it does not eliminate
 * it. Mitigation tracked upstream at moltzap#230 (`apps/transferInitiator`
 * follow-up).
 */
export function drainBridgeSessions(input: {
  readonly timeoutMs: number;
}): Promise<readonly string[]> {
  throw new Error("not implemented");
}

// Test-only escape hatch: reset the singleton between test runs.
export function __resetBridgeAppForTests(): void {
  throw new Error("not implemented");
}
