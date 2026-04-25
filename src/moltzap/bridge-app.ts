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
  loadBridgeIdentityEnv,
  normalizeServerUrl,
  registerBridgeAgent,
  type BridgeAgentId,
  type BridgeIdentity,
  type BridgeRegistrationError,
} from "./bridge-identity.ts";
import { buildAppIdentity } from "./manifest.ts";
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
  readonly registeredKeys: Set<ConversationKey>;
  readonly sessions: Set<string>;
}

let __bridgeSingleton: BridgeSingleton | null = null;

// In-flight boot sentinel: assigned synchronously (before any yield*) in
// bootBridgeApp so concurrent callers coalesce onto the same boot rather than
// starting a second registration + MoltZapApp.start(). Cleared on success
// (once __bridgeSingleton is set) or on failure (so a retry starts fresh).
let __bootInFlight: Promise<BridgeAppHandle> | null = null;

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
 * Invariant 1 (one MoltZapApp per bridge process): concurrent calls coalesce
 * onto the same in-flight boot; after boot, subsequent calls fail with
 * `BridgeAppAlreadyBooted`.
 *
 * Race-free: `__bootInFlight` is assigned synchronously (no yield* before it)
 * so the second concurrent caller always sees the sentinel and coalesces.
 *
 * **Fix 1 — sentinel cleanup under interruption (sbd#204).**
 * Sentinel clear is wrapped in `Effect.ensuring` so a fiber interrupted
 * between sentinel-assign and the success/failure clear still clears
 * `__bootInFlight`. Without this, an interrupted boot fiber leaves the
 * sentinel permanently non-null and all future callers deadlock awaiting
 * a Promise that will never resolve.
 * Codex delta-review concern (a), PR #338 post-cleanup.
 */
export function bootBridgeApp(
  config: BridgeAppBootConfig,
): Effect.Effect<BridgeAppHandle, BridgeAppBootError> {
  // Resolver/rejecter captured at function scope so the Effect.ensuring
  // finalizer can close over them regardless of where the fiber stops.
  let resolveInFlight: ((h: BridgeAppHandle) => void) | null = null;
  let rejectInFlight: ((e: BridgeAppBootError) => void) | null = null;

  const core = Effect.gen(function* () {
    // Already booted: reject immediately.
    if (__bridgeSingleton !== null) {
      return yield* Effect.fail<BridgeAppBootError>({
        _tag: "BridgeAppAlreadyBooted",
      });
    }

    // Boot in progress: coalesce — await the same in-flight result.
    // If the in-flight boot fails (or is interrupted), the rejection reason
    // surfaces via the catch below.
    if (__bootInFlight !== null) {
      return yield* Effect.tryPromise({
        try: () => __bootInFlight!,
        catch: (e) => e as BridgeAppBootError,
      });
    }

    // First caller: assign the sentinel SYNCHRONOUSLY before the first yield*.
    // JS is single-threaded — no other fiber can enter between the null-check
    // above and this assignment, closing the TOCTOU window.
    __bootInFlight = new Promise<BridgeAppHandle>((res, rej) => {
      resolveInFlight = res;
      rejectInFlight = rej;
    });
    // Suppress "unhandled rejection" warnings: if no concurrent caller
    // coalesces, this no-op handler marks the rejection as handled.
    // Actual error handling is done by callers that call rejectInFlight.
    __bootInFlight.catch(() => {});

    // Run the actual boot; capture success/failure without losing control flow.
    const bootResult = yield* _doBoot(config).pipe(Effect.either);

    if (bootResult._tag === "Left") {
      // Clear sentinel so a retry starts a fresh boot.
      __bootInFlight = null;
      rejectInFlight!(bootResult.left);
      resolveInFlight = null;
      rejectInFlight = null;
      return yield* Effect.fail(bootResult.left);
    }

    // Success: __bridgeSingleton set inside _doBoot.
    // Clear sentinel then resolve so concurrent waiters get the same handle.
    __bootInFlight = null;
    resolveInFlight!(bootResult.right);
    resolveInFlight = null;
    rejectInFlight = null;
    return bootResult.right;
  });

  // Ensuring finalizer: fires after success, failure, AND fiber interruption.
  // On the success/failure paths __bootInFlight is already null (cleared above),
  // so this is a no-op. On interruption it may still be set; clear it and reject
  // the in-flight promise so any coalescing callers are unblocked.
  return core.pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (__bootInFlight !== null) {
          __bootInFlight = null;
          rejectInFlight?.({
            _tag: "BridgeAppEnvInvalid",
            reason: "boot fiber interrupted before completing",
          });
          resolveInFlight = null;
          rejectInFlight = null;
        }
      }),
    ),
  );
}

/**
 * Internal boot sequence. On success, assigns `__bridgeSingleton` and returns
 * the handle. Does NOT manage `__bootInFlight` — that is `bootBridgeApp`'s
 * responsibility.
 */
function _doBoot(
  config: BridgeAppBootConfig,
): Effect.Effect<BridgeAppHandle, BridgeAppBootError> {
  return Effect.gen(function* () {
    const env = config.env ?? process.env;
    const logger = config.logger ?? defaultLogger();

    // Fix 3 (sbd#204): normalize the server URL before any use. The vendor
    // ws-client appends "/ws" unconditionally; a URL already ending in "/ws"
    // produces "/ws/ws" at connect time. Strip trailing "/ws" and "/" here
    // so both `ws://host:port` and `ws://host:port/ws` reach the SDK as
    // `ws://host:port`. normalizeServerUrl is in bridge-identity.ts (the
    // boundary-decode module) and is also applied inside toHttpBaseUrl for
    // the HTTP registration endpoint.
    const serverUrl = normalizeServerUrl(config.serverUrl);

    const envResult = loadBridgeIdentityEnv(env);
    if (envResult._tag === "Err") {
      return yield* Effect.fail<BridgeAppBootError>({
        _tag: "BridgeAppEnvInvalid",
        reason: envResult.error.reason,
      });
    }

    const appIdentity = buildAppIdentity(envResult.value.displayName);

    const registration = yield* Effect.promise(() =>
      registerBridgeAgent({
        serverUrl,
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
      serverUrl,
      agentKey: identity.agentKey,
      manifest,
      logger,
    });

    const registeredKeys = new Set<ConversationKey>();
    const sessions = new Set<string>();

    const handle: BridgeAppHandle = {
      agentId: identity.agentId,
      displayName: identity.displayName,
      onBridgeMessage: (key, handler) => {
        if (registeredKeys.has(key)) {
          return { _tag: "BridgeHandlerAlreadyRegistered", key };
        }
        registeredKeys.add(key);
        app.onMessage(key, (message) => handler(message));
        return null;
      },
      listActiveSessions: () => [...sessions],
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
      registeredKeys,
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
 *
 * **Fix 2 — shutdown-vs-boot ordering (sbd#204, option a).**
 * If a boot is in-flight when `shutdownBridgeApp` is called, it awaits
 * the boot to settle (success or failure) before tearing down the
 * resulting singleton. Without this, `shutdownBridgeApp` would no-op
 * (singleton is still null), the boot would complete and install a live
 * `MoltZapApp`, and nothing would ever stop it — a ghost singleton.
 *
 * Option (b) — cancelling the boot fiber — was considered and rejected:
 * `bootBridgeApp` is an Effect whose fiber is owned by the caller;
 * `shutdownBridgeApp` holds no fiber handle and cannot interrupt it
 * without API surface that is not in the plan. Option (a) is safe,
 * composes correctly with Fix 1 (`Effect.ensuring` guarantees
 * `__bootInFlight` is always settled before clearing, so this await
 * cannot deadlock), and requires zero new public surface.
 * Codex delta-review concern (a), PR #338 post-cleanup.
 */
export function shutdownBridgeApp(): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    // Await any in-flight boot so we do not miss a singleton that is still
    // being constructed. The Promise settles on both success and failure
    // (reject path is caught via the no-op second argument).
    const inFlight = __bootInFlight;
    if (inFlight !== null) {
      yield* Effect.promise(() => inFlight.then(() => {}, () => {}));
    }

    const state = __bridgeSingleton;
    if (state === null) return;
    yield* state.app.stop();
    state.registeredKeys.clear();
    state.sessions.clear();
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

    // rev 4 §2.3: architect API uses named-field; SDK uses positional.
    const invitedIds = request.invitedAgentIds.map((id) => id as string);
    const session = yield* state.app
      .createSession(invitedIds)
      .pipe(
        Effect.mapError(
          (cause): BridgeSessionError => ({
            _tag: "BridgeSessionCreateFailed",
            cause,
          }),
        ),
      );

    // Principle 2: the SDK hands back `Record<string, string>`; freeze
    // a snapshot of the keys we actually recognize so downstream callers
    // cannot mutate the session's conversation table.
    const frozen = Object.freeze({ ...session.conversations }) as Readonly<
      Record<ConversationKey, string>
    >;
    state.sessions.add(session.id);

    return {
      sessionId: session.id,
      conversations: frozen,
      onMessage: (key, handler) =>
        state.handle.onBridgeMessage(key, handler),
    };
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
    // Prune the registry whether the RPC succeeds or fails so drain can
    // account for leaked ids without monotonic growth across retries.
    const mapError = (cause: unknown): BridgeCloseSessionError => ({
      _tag: "BridgeCloseSessionFailed",
      cause: new SessionError(
        `apps/closeSession failed for ${sessionId}`,
        cause instanceof Error ? cause : undefined,
      ),
    });
    yield* state.app.client
      .sendRpc("apps/closeSession", { sessionId })
      .pipe(
        Effect.mapError(mapError),
        Effect.ensuring(
          Effect.sync(() => {
            state.sessions.delete(sessionId);
          }),
        ),
      );
  });
}

/**
 * SIGTERM-drain helper: enumerate active sessions held by this bridge
 * process and close them concurrently under one shared `timeoutMs`
 * budget. Any session whose close has not resolved when the budget
 * expires is reported as leaked (moltzap#230). Returns the list of
 * leaked sessionIds for telemetry.
 *
 * Concurrency + single budget matters: with N sessions the serial
 * variant could spend `N * perSessionLatency` instead of one
 * `timeoutMs`, starving later ids.
 */
export async function drainBridgeSessions(input: {
  readonly timeoutMs: number;
}): Promise<readonly string[]> {
  const state = __bridgeSingleton;
  if (state === null) return [];

  const ids = [...state.sessions];
  if (ids.length === 0) return [];

  const budget = Math.max(0, input.timeoutMs);
  const leaked = new Set<string>(ids);

  // Effect.race interrupts the losing fiber so in-flight closes do not
  // continue mutating state past the deadline. Previously, Promise.race
  // left orphaned in-flight Effects that mutated state.sessions after
  // drainBridgeSessions returned. Effect.tap only runs on success, so
  // timed-out sessions stay in the leaked set.
  await Effect.runPromise(
    Effect.race(
      Effect.forEach(
        ids,
        (sessionId) =>
          closeBridgeSession(sessionId).pipe(
            Effect.tap(() => Effect.sync(() => leaked.delete(sessionId))),
            Effect.ignore,
          ),
        { concurrency: "unbounded", discard: true },
      ),
      Effect.sleep(budget),
    ),
  );

  return [...leaked];
}

// Test-only escape hatch: reset the singleton between test runs.
export function __resetBridgeAppForTests(): void {
  const state = __bridgeSingleton;
  if (state !== null) {
    state.registeredKeys.clear();
    state.sessions.clear();
  }
  __bridgeSingleton = null;
  __bootInFlight = null;
}
