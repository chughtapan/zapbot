/**
 * bridge-process — boot/reload/shutdown lifecycle primitive for `runBridgeProcess`.
 *
 * STUBS ONLY (architect, sbd#215). Function bodies throw. Implementer
 * (`/safer:implement-staff` or `/safer:implement-senior`) fills the bodies
 * against the design doc on https://github.com/chughtapan/safer-by-default/issues/215.
 *
 * This module exists to fix three pre-existing races in `runBridgeProcess`
 * (preserved verbatim from the pre-collapse `bin/webhook-bridge.ts::main()`):
 *
 *   1. Signal handlers were installed AFTER the post-boot health probe.
 *      A SIGTERM during boot was lost (or terminated the process via the
 *      Node default handler) before in-flight registration could finish.
 *   2. `liveRuntime` was mutated BEFORE `running.reload(...)` resolved.
 *      If `running.reload` threw, `liveRuntime` was already advanced and
 *      the bridge runtime entered a half-replaced state.
 *   3. SIGHUP was not gated by `shuttingDown`. A SIGHUP arriving during
 *      graceful shutdown started a reload that raced shutdown finalizers.
 *
 * The two primitives published here address all three:
 *
 *   - `installBridgeProcessLifecycle` installs SIGHUP/SIGINT/SIGTERM
 *     handlers BEFORE any boot I/O. Handlers dispatch through an explicit
 *     state machine: signals received during `Booting` queue (SIGHUP) or
 *     pre-empt boot (SIGINT/SIGTERM); signals during `Reloading` defer
 *     shutdown until the reload commit/rollback completes; SIGHUP during
 *     `ShuttingDown` is a no-op.
 *
 *   - `prepareReload` / `commitReload` enforce validate-then-commit. The
 *     plan is built without touching the live runtime; the live runtime
 *     ref is updated only after `running.reload(plan.nextConfig)` resolves
 *     Ok. On reject, the previous runtime stays installed.
 *
 * Confined to the lifecycle/signal/reload surface of `runBridgeProcess`.
 * `startBridge` (HTTP server, gateway register/deregister, MoltZap boot)
 * is unchanged.
 */

import type { BridgeRuntimeConfig, ConfigReloadError } from "./config/types.ts";
import type { BridgeConfig, RunningBridge } from "./bridge.ts";
import type { Result } from "./types.ts";

// ── State ───────────────────────────────────────────────────────────

/**
 * Lifecycle phase. The state machine is linear with one branch:
 *
 *   Booting → Ready ─┬─ Reloading → Ready
 *                    └─ ShuttingDown   (terminal)
 *
 * - `Booting`: handlers installed; no live `RunningBridge` yet. SIGHUP
 *   queues until `markReady`. SIGTERM/SIGINT pre-empts boot — the
 *   caller of `installBridgeProcessLifecycle` MUST observe `state()`
 *   between boot steps and bail with `requestShutdown` if it has flipped.
 * - `Ready`: server up, registered, post-boot probe passed.
 * - `Reloading`: SIGHUP in flight. SIGHUP arriving in this phase logs
 *   and no-ops (existing `reloadInFlight` semantics, preserved).
 * - `ShuttingDown`: terminal. SIGHUP is a no-op. SIGINT/SIGTERM is
 *   idempotent (prior `shuttingDown` flag, preserved).
 */
export type BridgeProcessState =
  | { readonly _tag: "Booting" }
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Reloading" }
  | { readonly _tag: "ShuttingDown"; readonly reason: ShutdownReason };

export type ShutdownReason =
  | { readonly _tag: "Signal"; readonly signal: "SIGINT" | "SIGTERM" }
  | { readonly _tag: "BootProbeFailed"; readonly publicUrl: string }
  | { readonly _tag: "BootConfigInvalid"; readonly reason: string }
  | { readonly _tag: "Manual"; readonly reason: string };

// ── Lifecycle handle ────────────────────────────────────────────────

export interface BridgeProcessLifecycle {
  /** Read-only snapshot of the current phase. */
  readonly state: () => BridgeProcessState;

  /**
   * Transition `Booting` → `Ready`. Idempotent: no-op if state is not
   * `Booting`. After this call, queued SIGHUPs (if any) are dispatched
   * onto the supplied `running` handle. The `runtime` param becomes the
   * initial value of the live runtime ref returned by `liveRuntime()`.
   */
  readonly markReady: (
    running: RunningBridge,
    runtime: BridgeRuntimeConfig,
  ) => void;

  /**
   * Current live runtime ref. Mutated only by `commitReload` on success.
   * Returns `null` while in `Booting` (no runtime installed yet).
   */
  readonly liveRuntime: () => BridgeRuntimeConfig | null;

  /**
   * Trigger graceful shutdown from a non-signal source (boot probe
   * failure, fatal config error). Idempotent. Resolves once `running.stop()`
   * has finished and `process.exit` has been requested. Callers in
   * `Booting` may invoke this before any `RunningBridge` exists; the
   * lifecycle drops the exit through `deps.exit(1)`.
   */
  readonly requestShutdown: (reason: ShutdownReason) => Promise<void>;

  /**
   * Detach signal handlers. Test-only; production never disposes (the
   * process is exiting). Must be called from a non-signal context.
   */
  readonly dispose: () => void;
}

// ── Reload validation/commit ────────────────────────────────────────

/**
 * Validated reload plan. Construct only via `prepareReload`. Holds the
 * staged `nextRuntime` and `nextConfig` — neither has been applied to
 * the live bridge yet.
 */
export interface ReloadPlan {
  readonly nextRuntime: BridgeRuntimeConfig;
  readonly nextConfig: BridgeConfig;
  readonly secretRotated: boolean;
}

export type ReloadPrepareError =
  | { readonly _tag: "ReloadInputsFailed"; readonly reason: string }
  | { readonly _tag: "ReloadConfigInvalid"; readonly cause: ConfigReloadError }
  | { readonly _tag: "ReloadBuildFailed"; readonly reason: string };

export type ReloadCommitError =
  | {
      readonly _tag: "ReloadCommitFailed";
      readonly cause: string;
      /** True if `running.reload(previous)` succeeded after the failed swap. */
      readonly rolledBack: boolean;
    }
  | {
      readonly _tag: "ReloadRollbackFailed";
      readonly originalCause: string;
      readonly rollbackCause: string;
    };

// ── Public surface ──────────────────────────────────────────────────

export interface BridgeProcessLifecycleDeps {
  /** Process env (test-injectable). */
  readonly env: NodeJS.ProcessEnv;
  /** `/healthz` reachability probe; injectable for tests. */
  readonly probe: (publicUrl: string) => Promise<boolean>;
  /**
   * The Node `process`-like object whose `.on` we register signal
   * handlers against. Test-injectable; production passes `process`.
   */
  readonly process: Pick<NodeJS.Process, "on" | "off">;
  /**
   * Process-exit shim. Test-injectable; production passes
   * `(code) => process.exit(code)`. Architect note: NEVER call
   * `process.exit` directly inside this module — always go through
   * `deps.exit` so tests can observe shutdown without killing the runner.
   */
  readonly exit: (code: number) => never;
  /** Logger; reuses `createLogger("bridge")` in production. */
  readonly logger: {
    readonly info: (msg: string) => void;
    readonly warn: (msg: string) => void;
    readonly error: (msg: string) => void;
  };
}

/**
 * Install SIGHUP/SIGINT/SIGTERM handlers and return a lifecycle handle.
 *
 * **MUST be called BEFORE any boot I/O.** Specifically: before
 * `loadBridgeInputs`, before `startBridge`, before the post-boot probe.
 * Race 1 from sbd#215 is resolved by this ordering invariant — the
 * signal handlers exist throughout boot, so a SIGTERM mid-boot trips
 * the lifecycle's `Booting → ShuttingDown` transition rather than being
 * caught by the Node default handler.
 *
 * Returned handle starts in state `Booting`. Caller boots, then calls
 * `markReady(running, runtime)`. If boot fails, caller calls
 * `requestShutdown({ _tag: "Boot..." })`.
 */
export function installBridgeProcessLifecycle(
  deps: BridgeProcessLifecycleDeps,
): BridgeProcessLifecycle {
  throw new Error("not implemented");
}

/**
 * Validate-then-commit phase 1. Reads disk, runs ingress resolution,
 * runs `reloadBridgeRuntimeConfig` and `buildBridgeConfig` — all of
 * which can fail without touching the live bridge. Returns the
 * `ReloadPlan` that `commitReload` will apply atomically.
 *
 * **Pure failure mode — never mutates the live runtime ref.** Race 2
 * from sbd#215 is resolved at this seam: validation is a separate
 * call from commit, and only the commit advances state.
 */
export async function prepareReload(
  env: NodeJS.ProcessEnv,
  currentRuntime: BridgeRuntimeConfig,
  probe: (publicUrl: string) => Promise<boolean>,
): Promise<Result<ReloadPlan, ReloadPrepareError>> {
  throw new Error("not implemented");
}

/**
 * Validate-then-commit phase 2. Calls `running.reload(plan.nextConfig)`,
 * then on success returns `plan.nextRuntime` for the caller to install
 * as the new live runtime.
 *
 * On `running.reload` rejection, attempts rollback by re-applying the
 * `previousConfig` derived from `previousRuntime`. The lifecycle's
 * `liveRuntime` ref is updated by the caller (`installBridgeProcessLifecycle`'s
 * SIGHUP handler) — this function is purely transactional over `running`.
 *
 * Race 2 from sbd#215 is resolved here: the `liveRuntime` mutation in
 * `runBridgeProcess` (formerly at `bridge.ts:1218`, before
 * `running.reload`) moves AFTER this function resolves Ok.
 */
export async function commitReload(
  running: RunningBridge,
  plan: ReloadPlan,
  previousRuntime: BridgeRuntimeConfig,
  previousConfig: BridgeConfig,
): Promise<Result<BridgeRuntimeConfig, ReloadCommitError>> {
  throw new Error("not implemented");
}
