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
 *   3. `new MoltZapApp({ serverUrl, agentKey, manifest: buildUnionManifest(...) })`.
 *   4. `app.start()` — internally connects WS (sends `auth/connect` with
 *      `agentKey`), calls `apps/register` with the union manifest, and
 *      ALSO calls `apps/create` with no `invitedAgentIds`. The seed
 *      session created at boot is closed immediately (see
 *      `closeBridgeBootSession`); per-spawn sessions are created via
 *      `createBridgeSession` below.
 *   5. Singleton recorded in `__bridgeSingleton`. `bridgeAgentId()` is
 *      now non-null.
 *
 * **Lifetime.** Exactly one `MoltZapApp` per bridge process. Constructed
 * once at boot; torn down once at SIGTERM. Heartbeat + reconnect are
 * SDK-managed (`MoltZapApp` ctor `heartbeatIntervalMs` default 30s;
 * `recoverSessionOnReconnect` for in-flight sessions).
 *
 * **SIGHUP policy.** `bridge-app.ts` is NOT touched by SIGHUP. The
 * SIGHUP reload path in `bin/webhook-bridge.ts:229` reloads bridge
 * config (allowlist, repo set, secret rotation) without tearing down
 * the WS or active sessions. Implementation note: `reloadBridge` MUST
 * NOT call `shutdownBridgeApp`. If the registration secret rotates,
 * the `MoltZapApp` keeps its existing `agentKey` (already minted);
 * a future secret rotation triggers a `BridgeAgentKeyRotationStale`
 * error only on a subsequent `registerBridgeAgent` call (i.e., next
 * process boot). v1 accepts this — reissuing per-process is a
 * post-merge operability follow-up.
 *
 * **Silence invariant (A+C(2) — bridge silent at app layer).** This
 * module deliberately omits any `send`, `sendOnKey`, `sendTo`, or
 * `reply` export. The bridge handle's escape hatch to the underlying
 * `MoltZapApp` is wrapped in `BridgeApp` such that the type system
 * rejects calls that would author a message in a role-pair conversation
 * (see `bridge-silence.ts`). Bridge code that needs to OBSERVE inbound
 * traffic uses `onBridgeMessage(key, handler)` — read-only.
 *
 * **Session ownership.** The bridge is the session initiator
 * (`apps/create` caller). It holds `apps/closeSession` privilege per
 * upstream `app-host.ts:803` invariant. moltzap#230 (initiator-death
 * leak) is accepted for v1 — see §"Operational posture" in the design
 * doc.
 */

import { Effect } from "effect";
import type { Message, WsClientLogger } from "@moltzap/app-sdk";
import type { ConversationKey } from "./conversation-keys.ts";
import type {
  BridgeAgentId,
  BridgeIdentity,
  BridgeRegistrationError,
} from "./bridge-identity.ts";
import type { MoltzapSenderId } from "./types.ts";

// ── Boot config + errors ────────────────────────────────────────────

export interface BridgeAppBootConfig {
  readonly serverUrl: string;
  readonly registrationSecret: string;
  readonly env?: Record<string, string | undefined>;
  readonly logger?: WsClientLogger;
}

export type BridgeAppBootError =
  | { readonly _tag: "BridgeAppAlreadyBooted" }
  | {
      readonly _tag: "BridgeAppRegistrationFailed";
      readonly cause: BridgeRegistrationError;
    }
  | {
      readonly _tag: "BridgeAppManifestInvalid";
      readonly reason: string;
    }
  | {
      readonly _tag: "BridgeAppConnectFailed";
      readonly cause: string;
    }
  | {
      readonly _tag: "BridgeAppSessionFailed";
      readonly cause: string;
    };

// ── Public handle ───────────────────────────────────────────────────

/**
 * Opaque handle returned by `bootBridgeApp`. Notably absent: any send
 * surface. The bridge is silent at the app layer (A+C(2)). The handle
 * carries:
 *   - `agentId`: privileged BridgeAgentId for `apps/closeSession`.
 *   - read-only `onBridgeMessage(key, handler)` for observability.
 *   - session-creation surface (initiator privilege).
 */
export interface BridgeAppHandle {
  readonly agentId: BridgeAgentId;
  readonly identity: BridgeIdentity;
  /**
   * Read-only inbound observation. Returns the handler-registration
   * receipt or a typed error. Bridge code uses this for roster/budget
   * tracking; it does NOT (and cannot) send replies.
   */
  readonly onBridgeMessage: (
    key: ConversationKey,
    handler: (message: Message) => void | Promise<void>,
  ) => BridgeMessageHandlerError | null;
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
 * RosterManager (see `bin/webhook-bridge.ts` boot order in the design
 * doc §"Data flow").
 */
export function bridgeAgentId(): BridgeAgentId | null {
  throw new Error("not implemented");
}

/**
 * Tear down the bridge's `MoltZapApp`. Idempotent. Called at SIGTERM
 * and at process exit. NOT called by SIGHUP reload.
 */
export function shutdownBridgeApp(): Effect.Effect<void, never> {
  throw new Error("not implemented");
}

// ── Per-spawn session creation (initiator authority) ────────────────

export interface BridgeSessionRequest {
  /** SenderIds of every roster member to invite at session-create time. */
  readonly invitedAgentIds: readonly MoltzapSenderId[];
}

export type BridgeSessionError =
  | { readonly _tag: "BridgeAppNotBooted" }
  | {
      readonly _tag: "BridgeSessionCreateFailed";
      readonly cause: string;
    };

/**
 * Create a per-spawn `AppSession` from the bridge's long-lived
 * `MoltZapApp`. Wraps `MoltZapApp.createSession({invitedAgentIds})`.
 *
 * Returned `BridgeSessionHandle` exposes only:
 *   - `sessionId` for opaque routing.
 *   - `conversations` map (typed `ConversationKey` → raw conversationId).
 *   - read-only `onMessage(key, handler)`.
 *
 * Send is not exposed. Worker processes hold their own send surface
 * via `worker-app.ts`; they receive session join via `app/sessionReady`
 * once the bridge calls `createSession({invitedAgentIds: [workerId]})`.
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
      readonly cause: string;
    };

/**
 * Close a session by id. Caller must be the bridge (initiator); upstream
 * `app-host.ts:803` enforces this. Used at session end + at bridge
 * SIGTERM drain (see `drainBridgeSessions`).
 */
export function closeBridgeSession(
  sessionId: string,
): Effect.Effect<void, BridgeCloseSessionError> {
  throw new Error("not implemented");
}

/**
 * SIGTERM-drain helper: enumerate active sessions held by this bridge
 * process and close each in order. Bounded by `timeoutMs`; on timeout,
 * remaining sessions leak (moltzap#230). Returns the list of leaked
 * sessionIds for telemetry.
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
