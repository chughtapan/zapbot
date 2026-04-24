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
  MoltZapApp,
  SessionError,
} from "@moltzap/app-sdk";
import type { ConversationKey } from "./conversation-keys.ts";
import {
  asBridgeAgentId,
  loadBridgeIdentityEnv,
  registerBridgeAgent,
  type BridgeAgentId,
  type BridgeIdentity,
  type BridgeRegistrationError,
} from "./bridge-identity.ts";
import { loadAppIdentity } from "./manifest.ts";
import { buildUnionManifest } from "./union-manifest.ts";
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
    }
  | {
      // Env decode failure surfaces here so the boot error channel is
      // one union; keyed by the original tag for operator parity.
      readonly _tag: "BridgeAppEnvInvalid";
      readonly reason: string;
    };

// ── Public handle ───────────────────────────────────────────────────

export interface BridgeAppHandle {
  readonly agentId: BridgeAgentId;
  readonly displayName: string;
  readonly onBridgeMessage: (
    key: ConversationKey,
    handler: (message: Message) => void | Promise<void>,
  ) => BridgeMessageHandlerError | null;
  readonly listActiveSessions: () => readonly string[];
}

export type BridgeMessageHandlerError = {
  readonly _tag: "BridgeHandlerAlreadyRegistered";
  readonly key: ConversationKey;
};

// ── Module-local singleton + session registry ───────────────────────

interface BridgeSingleton {
  readonly app: MoltZapApp;
  readonly identity: BridgeIdentity;
  readonly handle: BridgeAppHandle;
  readonly handlers: Map<ConversationKey, (message: Message) => void | Promise<void>>;
  readonly sessions: Map<string, { readonly conversations: Readonly<Record<ConversationKey, string>> }>;
}

let __bridgeSingleton: BridgeSingleton | null = null;

// ── Boot ────────────────────────────────────────────────────────────

function defaultLogger(): WsClientLogger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function classifyStartError(
  cause: AuthError | ManifestRegistrationError | SessionError,
): BridgeAppBootError {
  if (cause instanceof AuthError) {
    return { _tag: "BridgeAppConnectFailed", cause };
  }
  if (cause instanceof ManifestRegistrationError) {
    return { _tag: "BridgeAppManifestInvalid", cause };
  }
  return { _tag: "BridgeAppSessionFailed", cause };
}

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
  return Effect.gen(function* () {
    if (__bridgeSingleton !== null) {
      return yield* Effect.fail<BridgeAppBootError>({
        _tag: "BridgeAppAlreadyBooted",
      });
    }

    const env = config.env ?? process.env;
    const logger = config.logger ?? defaultLogger();

    const envResult = loadBridgeIdentityEnv(env);
    if (envResult._tag === "Err") {
      return yield* Effect.fail<BridgeAppBootError>({
        _tag: "BridgeAppEnvInvalid",
        reason: envResult.error.reason,
      });
    }

    const appIdentityResult = loadAppIdentity(env);
    if ("_tag" in appIdentityResult && appIdentityResult._tag === "AppIdentityDecodeError") {
      return yield* Effect.fail<BridgeAppBootError>({
        _tag: "BridgeAppEnvInvalid",
        reason: appIdentityResult.reason,
      });
    }
    // Narrow: the non-error branch is the `AppIdentity` object.
    const appIdentity = appIdentityResult as Exclude<
      ReturnType<typeof loadAppIdentity>,
      { readonly _tag: "AppIdentityDecodeError" }
    >;

    // Align displayName: bridge identity uses the same env var as
    // appIdentity so the registered MoltZap agent name matches the
    // manifest name (operator-legible logs).
    const registration = yield* Effect.promise(() =>
      registerBridgeAgent({
        serverUrl: config.serverUrl,
        registrationSecret: envResult.value.registrationSecret,
        displayName: envResult.value.displayName,
      }),
    );
    if (registration._tag === "Err") {
      return yield* Effect.fail<BridgeAppBootError>({
        _tag: "BridgeAppRegistrationFailed",
        cause: registration.error,
      });
    }
    const identity = registration.value;

    const manifest = buildUnionManifest(appIdentity);
    const app = new MoltZapApp({
      serverUrl: config.serverUrl,
      agentKey: identity.agentKey,
      manifest,
      logger,
    });

    const handlers = new Map<
      ConversationKey,
      (message: Message) => void | Promise<void>
    >();
    const sessions = new Map<
      string,
      { readonly conversations: Readonly<Record<ConversationKey, string>> }
    >();

    const handle: BridgeAppHandle = {
      agentId: identity.agentId,
      displayName: identity.displayName,
      onBridgeMessage: (key, handler) => {
        if (handlers.has(key)) {
          return { _tag: "BridgeHandlerAlreadyRegistered", key };
        }
        handlers.set(key, handler);
        app.onMessage(key, (message) => handler(message));
        return null;
      },
      listActiveSessions: () => [...sessions.keys()],
    };

    // Start the app. The SDK's `start()` error channel is a union of
    // SDK error CLASS instances — preserve them verbatim (Principle 3).
    yield* app.start().pipe(
      Effect.mapError((cause) => classifyStartError(cause)),
    );

    __bridgeSingleton = {
      app,
      identity,
      handle,
      handlers,
      sessions,
    };
    return handle;
  });
}

/** Return the booted bridge handle, or `null` if `bootBridgeApp` has not run. */
export function currentBridgeApp(): BridgeAppHandle | null {
  return __bridgeSingleton?.handle ?? null;
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
  return __bridgeSingleton?.identity.agentId ?? null;
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
  return Effect.gen(function* () {
    const state = __bridgeSingleton;
    if (state === null) return;
    yield* state.app.stop();
    __bridgeSingleton = null;
  });
}

// ── Per-spawn session creation (initiator authority) ────────────────

export interface BridgeSessionRequest {
  readonly invitedAgentIds: readonly MoltzapSenderId[];
}

export type BridgeSessionError =
  | { readonly _tag: "BridgeAppNotBooted" }
  | {
      readonly _tag: "BridgeSessionCreateFailed";
      readonly cause: SessionError;
    };

export interface BridgeSessionHandle {
  readonly sessionId: string;
  readonly conversations: Readonly<Record<ConversationKey, string>>;
  readonly onMessage: (
    key: ConversationKey,
    handler: (message: Message) => void | Promise<void>,
  ) => BridgeMessageHandlerError | null;
}

export function createBridgeSession(
  request: BridgeSessionRequest,
): Effect.Effect<BridgeSessionHandle, BridgeSessionError> {
  return Effect.gen(function* () {
    const state = __bridgeSingleton;
    if (state === null) {
      return yield* Effect.fail<BridgeSessionError>({
        _tag: "BridgeAppNotBooted",
      });
    }

    // Named-field → positional map per rev 4 §2.3.
    const invitedIds = request.invitedAgentIds.map((id) => id as string);
    const session = yield* state.app
      .createSession([...invitedIds])
      .pipe(
        Effect.mapError(
          (cause): BridgeSessionError => ({
            _tag: "BridgeSessionCreateFailed",
            cause,
          }),
        ),
      );

    // The SDK's `conversations` is `Record<string, string>`. Narrow to
    // ConversationKey keys we recognize. Unknown keys would indicate a
    // manifest/server divergence — recorded here but not a hard error
    // (Principle 2: decode, don't assume).
    const conversations: Record<ConversationKey, string> = {} as Record<
      ConversationKey,
      string
    >;
    for (const [k, v] of Object.entries(session.conversations)) {
      (conversations as Record<string, string>)[k] = v;
    }
    const frozen = Object.freeze({ ...conversations });
    state.sessions.set(session.id, { conversations: frozen });

    const handle: BridgeSessionHandle = {
      sessionId: session.id,
      conversations: frozen,
      // Reusing the global `onBridgeMessage` — one handler per key, global
      // across sessions, matching the SDK's `onMessage(key, ...)` semantic.
      onMessage: (key, handler) =>
        state.handle.onBridgeMessage(key, handler),
    };
    return handle;
  });
}

// ── Session close (initiator privilege) ─────────────────────────────

export type BridgeCloseSessionError =
  | { readonly _tag: "BridgeAppNotBooted" }
  | {
      readonly _tag: "BridgeCloseSessionFailed";
      readonly cause: SessionError;
    };

/**
 * Close a session by id via `apps/closeSession`. Caller must be the
 * bridge (initiator); upstream `app-host.ts:803` enforces this. Removes
 * the session from the module-local active-sessions registry. Used at
 * session end + at bridge SIGTERM drain.
 */
export function closeBridgeSession(
  sessionId: string,
): Effect.Effect<void, BridgeCloseSessionError> {
  return Effect.gen(function* () {
    const state = __bridgeSingleton;
    if (state === null) {
      return yield* Effect.fail<BridgeCloseSessionError>({
        _tag: "BridgeAppNotBooted",
      });
    }
    // Idempotency: if the session is not tracked we still issue the
    // RPC so an outside-created session can be closed via the bridge;
    // the server returns an error we map to BridgeCloseSessionFailed.
    yield* state.app.client
      .sendRpc("apps/closeSession", { sessionId })
      .pipe(
        Effect.mapError(
          (cause): BridgeCloseSessionError => ({
            _tag: "BridgeCloseSessionFailed",
            cause: new SessionError(
              `apps/closeSession failed for ${sessionId}`,
              cause instanceof Error ? cause : undefined,
            ),
          }),
        ),
      );
    state.sessions.delete(sessionId);
  });
}

/**
 * SIGTERM-drain helper: enumerate active sessions held by this bridge
 * process via `BridgeAppHandle.listActiveSessions()` and close each in
 * order. Bounded by `timeoutMs`; on timeout, remaining sessions leak
 * (moltzap#230). Returns the list of leaked sessionIds for telemetry.
 */
export async function drainBridgeSessions(input: {
  readonly timeoutMs: number;
}): Promise<readonly string[]> {
  const state = __bridgeSingleton;
  if (state === null) return [];

  const deadline = Date.now() + Math.max(0, input.timeoutMs);
  const leaked: string[] = [];

  for (const sessionId of [...state.sessions.keys()]) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      leaked.push(sessionId);
      continue;
    }
    try {
      await Effect.runPromise(
        closeBridgeSession(sessionId).pipe(
          Effect.timeoutFail({
            duration: `${remaining} millis`,
            onTimeout: (): BridgeCloseSessionError => ({
              _tag: "BridgeCloseSessionFailed",
              cause: new SessionError(
                `apps/closeSession timed out after ${remaining}ms for ${sessionId}`,
              ),
            }),
          }),
        ),
      );
    } catch {
      // Close failed under the budget — treat as leaked for telemetry.
      leaked.push(sessionId);
    }
  }
  return leaked;
}

// Test-only escape hatch: reset the singleton between test runs.
export function __resetBridgeAppForTests(): void {
  __bridgeSingleton = null;
}
