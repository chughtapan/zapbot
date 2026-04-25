/**
 * bridge-process — boot/reload/shutdown lifecycle primitive for `runBridgeProcess`.
 *
 * Architect plan (sbd#215 rev 2 + addendum):
 *   - rev 1:    https://github.com/chughtapan/safer-by-default/issues/215#issuecomment-4318454290
 *   - addendum: https://github.com/chughtapan/safer-by-default/issues/215#issuecomment-4318476863
 *   - rev 2:    https://github.com/chughtapan/safer-by-default/issues/215#issuecomment-4318477234
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
 *     state machine: SIGHUP during `Booting` is a no-op (logged + dropped,
 *     same shape as SIGHUP during `Reloading`/`ShuttingDown`); SIGINT/SIGTERM
 *     during `Booting` pre-empts boot; signals during `Reloading` defer
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
 *
 * Atomicity boundary (rev 2 P1 #1): `commitReload` is transactional at the
 * `running.reload` THROW boundary only. Per-repo gateway register/deregister
 * failures returned via `Promise.allSettled` inside `running.reload` are
 * pre-existing semantics and are NOT rolled back here. The §6.3 follow-up
 * (gateway-layer transactionality) is a separate sub-issue (sbd#219).
 *
 * Boot pre-emption latency (rev 1 §6.1, default a): shutdown latency during
 * `Booting` is bounded by the longest remaining boot await — the boot caller
 * polls `state()` between awaits and bails to `requestShutdown` once a signal
 * has flipped state to `ShuttingDown`.
 */

import { absurd, err, ok, type Result } from "./types.ts";
import { buildBridgeConfig, loadBridgeInputs } from "./bridge.ts";
import type { BridgeConfig, RunningBridge } from "./bridge.ts";
import { reloadBridgeRuntimeConfig } from "./config/reload.ts";
import type { BridgeRuntimeConfig, ConfigReloadError } from "./config/types.ts";

// ── State ───────────────────────────────────────────────────────────

/**
 * Lifecycle phase. The state machine is linear with one branch:
 *
 *   Booting → Ready ─┬─ Reloading → Ready
 *                    └─ ShuttingDown   (terminal)
 *
 * - `Booting`: handlers installed; no live `RunningBridge` yet. SIGHUP
 *   is a no-op (logged + dropped — there is no `RunningBridge` to reload
 *   against, and no queue; matches the "no-op-on-non-Ready" pattern used
 *   by `Reloading` and `ShuttingDown`). SIGTERM/SIGINT pre-empts boot —
 *   the caller of `installBridgeProcessLifecycle` MUST observe `state()`
 *   between boot steps and bail with `requestShutdown` if it has flipped.
 * - `Ready`: server up, registered, post-boot probe passed.
 * - `Reloading`: SIGHUP in flight. SIGHUP arriving in this phase logs
 *   and no-ops (existing `reloadInFlight` semantics, preserved). SIGINT/
 *   SIGTERM records a shutdown intent and waits for the reload's
 *   commit-or-rollback to settle before transitioning to `ShuttingDown`.
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
   * `Booting`. The `runtime` param becomes the initial value of the live
   * runtime ref returned by `liveRuntime()`. SIGHUPs received during
   * `Booting` are NOT queued — they were dropped at receive time, so
   * `markReady` does not dispatch a deferred reload.
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
  // Mutable lifecycle state. Closed over by the signal handlers and the
  // returned handle; never escapes this function.
  let state: BridgeProcessState = { _tag: "Booting" };
  let running: RunningBridge | null = null;
  let liveRuntimeRef: BridgeRuntimeConfig | null = null;

  // Reload coordination. `reloadSettled` resolves once the in-flight
  // SIGHUP-triggered reload has finished its commit-or-rollback work.
  let reloadSettled: Promise<void> | null = null;

  // Pending shutdown intent recorded during `Reloading`. After the reload
  // settles, the finally block reads this and drives the transition.
  // Signal beats Manual per rev 2 P1 #3 (signal-wins-over-§6.2).
  let pendingShutdown: ShutdownReason | null = null;

  // Idempotent shutdown promise. First call to `requestShutdown` (or the
  // signal-driven internal equivalent) creates it; subsequent callers
  // await the same promise.
  let shutdownPromise: Promise<void> | null = null;

  function exitCodeFor(reason: ShutdownReason): 0 | 1 {
    switch (reason._tag) {
      case "Signal":
        return 0;
      case "BootProbeFailed":
      case "BootConfigInvalid":
      case "Manual":
        return 1;
      default:
        return absurd(reason);
    }
  }

  async function performShutdown(reason: ShutdownReason): Promise<void> {
    state = { _tag: "ShuttingDown", reason };
    if (running !== null) {
      try {
        await running.stop();
      } catch (e) {
        deps.logger.error(
          `running.stop() failed during shutdown: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    deps.exit(exitCodeFor(reason));
  }

  function startShutdown(reason: ShutdownReason): Promise<void> {
    if (shutdownPromise !== null) return shutdownPromise;
    shutdownPromise = performShutdown(reason);
    return shutdownPromise;
  }

  function describePrepareError(error: ReloadPrepareError): string {
    switch (error._tag) {
      case "ReloadInputsFailed":
        return error.reason;
      case "ReloadConfigInvalid":
        return `config rejected: ${error.cause._tag}`;
      case "ReloadBuildFailed":
        return error.reason;
      default:
        return absurd(error);
    }
  }

  function recordSignalIntent(signal: "SIGINT" | "SIGTERM"): void {
    const reason: ShutdownReason = { _tag: "Signal", signal };
    // Signal always wins over a previously-recorded Manual intent
    // (rev 2 P1 #3: signal-wins-over-§6.2 even when ReloadRollbackFailed
    // would otherwise drive force-shutdown).
    if (pendingShutdown === null || pendingShutdown._tag !== "Signal") {
      pendingShutdown = reason;
    }
  }

  function onSighup(): void {
    switch (state._tag) {
      case "Booting":
        // Race-3 fix per rev 2 P1 #2: no-op (no queue, no deferred dispatch).
        deps.logger.warn("SIGHUP ignored during boot");
        return;
      case "Reloading":
        // Existing `reloadInFlight` semantics preserved.
        deps.logger.warn("SIGHUP received while reload in flight; ignoring");
        return;
      case "ShuttingDown":
        // Race-3 fix: SIGHUP during shutdown does not race shutdown finalizers.
        deps.logger.warn("SIGHUP ignored during shutdown");
        return;
      case "Ready":
        // Fall through to the reload kickoff below.
        break;
      default:
        absurd(state);
    }

    // Capture a snapshot of the previous runtime so that rollback (if it
    // fires) has a consistent baseline.
    const previousRuntime = liveRuntimeRef;
    const liveRunning = running;
    if (previousRuntime === null || liveRunning === null) {
      // Defensive: Ready implies both are set (markReady wrote them).
      // If we get here, the lifecycle invariant is broken — fail loud.
      deps.logger.error(
        "SIGHUP in Ready state but live runtime/running missing; aborting reload",
      );
      return;
    }

    state = { _tag: "Reloading" };

    reloadSettled = (async () => {
      try {
        // Rebuild the previous BridgeConfig from the previous runtime.
        // buildBridgeConfig is a pure fold over env + runtime; it can only
        // fail if the Moltzap env decode fails, which is identical to
        // boot — env hasn't moved, so a failure here is anomalous.
        const previousConfigResult = buildBridgeConfig(deps.env, previousRuntime);
        if (previousConfigResult._tag === "Err") {
          deps.logger.error(
            `Reload aborted: cannot rebuild current config: ${previousConfigResult.error.reason}`,
          );
          return;
        }

        const planResult = await prepareReload(
          deps.env,
          previousRuntime,
          deps.probe,
        );
        if (planResult._tag === "Err") {
          deps.logger.error(`Reload failed: ${describePrepareError(planResult.error)}`);
          return;
        }

        const committed = await commitReload(
          liveRunning,
          planResult.value,
          previousRuntime,
          previousConfigResult.value,
        );
        if (committed._tag === "Err") {
          if (committed.error._tag === "ReloadCommitFailed") {
            deps.logger.error(
              `Reload failed: ${committed.error.cause}` +
                (committed.error.rolledBack
                  ? " (rolled back to previous config)"
                  : ""),
            );
            return;
          }
          // ReloadRollbackFailed: §6.2 default is force-shutdown.
          // Rev 2 P1 #3: if a SIGTERM is already pending, signal wins;
          // pendingShutdown stays as Signal.
          deps.logger.error(
            `Reload rollback failed: original=${committed.error.originalCause}; ` +
              `rollback=${committed.error.rollbackCause}`,
          );
          if (pendingShutdown === null) {
            pendingShutdown = {
              _tag: "Manual",
              reason: "rollback failed",
            };
          }
          return;
        }

        // Race-2 fix: liveRuntime advances ONLY after `commitReload` resolves Ok.
        liveRuntimeRef = committed.value;
        deps.logger.info(
          `Config reloaded (${planResult.value.nextConfig.repos.size} repos, ` +
            `secret rotated: ${planResult.value.secretRotated})`,
        );
      } catch (e) {
        deps.logger.error(
          `Reload failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      } finally {
        // Settle the state. If a signal arrived during the reload, the
        // pendingShutdown drives the transition (signal wins per rev 2).
        // Otherwise, return to Ready unless a Manual shutdown was queued
        // by a rollback failure.
        if (pendingShutdown !== null) {
          const reason = pendingShutdown;
          pendingShutdown = null;
          // Kick off shutdown asynchronously so we don't block the
          // SIGHUP handler's microtask further. Errors are observable
          // via the shutdownPromise.
          void startShutdown(reason);
        } else if (state._tag === "Reloading") {
          state = { _tag: "Ready" };
        }
      }
    })();
  }

  function onSignal(signal: "SIGINT" | "SIGTERM"): void {
    const reason: ShutdownReason = { _tag: "Signal", signal };
    switch (state._tag) {
      case "Booting":
        // Race-1 fix: handlers exist throughout boot. Flip state; the
        // boot caller polls `state()` between awaits and calls
        // `requestShutdown` once it observes the transition. Latency is
        // bounded by the longest remaining boot await (rev 1 §6.1 "a").
        deps.logger.info(`${signal} received during boot; pre-empting boot`);
        state = { _tag: "ShuttingDown", reason };
        return;
      case "Ready":
        deps.logger.info(`${signal} received; shutting down`);
        void startShutdown(reason);
        return;
      case "Reloading":
        // Rev 2 P1 #3 (a): do NOT abort the in-flight reload. Record the
        // intent; the reload's finally block drives the transition.
        deps.logger.info(
          `${signal} received during reload; deferring shutdown until reload settles`,
        );
        recordSignalIntent(signal);
        return;
      case "ShuttingDown":
        deps.logger.info(`${signal} ignored: already shutting down`);
        return;
      default:
        absurd(state);
    }
  }

  const sighupHandler = (): void => onSighup();
  const sigintHandler = (): void => onSignal("SIGINT");
  const sigtermHandler = (): void => onSignal("SIGTERM");

  deps.process.on("SIGHUP", sighupHandler);
  deps.process.on("SIGINT", sigintHandler);
  deps.process.on("SIGTERM", sigtermHandler);

  return {
    state: () => state,
    markReady: (r, runtime) => {
      // Always stash the running bridge on the FIRST hand-off — even if a
      // signal pre-empted boot and flipped state to `ShuttingDown` between
      // `start(cfg)` resolving and the boot caller reaching `markReady`.
      // Without this, `running` is leaked: the lifecycle's
      // `requestShutdown`/`performShutdown` see `running === null` and skip
      // graceful `running.stop()`, dropping gateway deregistration and
      // MoltZap session drain (codex review P1+P2 against impl-staff/sbd-220).
      if (running === null) {
        running = r;
        liveRuntimeRef = runtime;
      }
      if (state._tag === "Booting") {
        state = { _tag: "Ready" };
        return;
      }
      if (state._tag === "ShuttingDown") {
        // Signal flipped state during boot; drive the shutdown the signal
        // handler couldn't (it had no `running` to stop). Idempotent via
        // `shutdownPromise`.
        void startShutdown(state.reason);
      }
    },
    liveRuntime: () => liveRuntimeRef,
    requestShutdown: async (reason) => {
      // If a reload is mid-flight, let it settle first — tearing down a
      // half-applied reload is exactly race 2.
      if (state._tag === "Reloading") {
        if (pendingShutdown === null || pendingShutdown._tag !== "Signal") {
          pendingShutdown = reason;
        }
        // Wait for the reload to settle; the finally block will start
        // the shutdown via pendingShutdown.
        if (reloadSettled !== null) {
          try {
            await reloadSettled;
          } catch {
            /* settled with rejection; finally block already ran */
          }
        }
        if (shutdownPromise !== null) await shutdownPromise;
        return;
      }
      await startShutdown(reason);
    },
    dispose: () => {
      deps.process.off("SIGHUP", sighupHandler);
      deps.process.off("SIGINT", sigintHandler);
      deps.process.off("SIGTERM", sigtermHandler);
    },
  };
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
  const nextInputs = await loadBridgeInputs(env, env.ZAPBOT_CONFIG, probe);
  if (nextInputs._tag === "Err") {
    return err({ _tag: "ReloadInputsFailed", reason: nextInputs.error.reason });
  }

  const reloaded = reloadBridgeRuntimeConfig(currentRuntime, nextInputs.value);
  if (reloaded._tag === "Err") {
    return err({ _tag: "ReloadConfigInvalid", cause: reloaded.error });
  }

  const nextConfig = buildBridgeConfig(env, reloaded.value.next);
  if (nextConfig._tag === "Err") {
    return err({ _tag: "ReloadBuildFailed", reason: nextConfig.error.reason });
  }

  return ok({
    nextRuntime: reloaded.value.next,
    nextConfig: nextConfig.value,
    secretRotated: reloaded.value.secretRotated,
  });
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
 *
 * Atomicity is at the throw boundary only (rev 2 P1 #1). Per-repo
 * gateway register/deregister failures returned as `Err` via
 * `Promise.allSettled` inside `running.reload` are NOT detected here;
 * sbd#219 (§6.3 follow-up) addresses gateway-layer transactionality.
 */
export async function commitReload(
  running: RunningBridge,
  plan: ReloadPlan,
  _previousRuntime: BridgeRuntimeConfig,
  previousConfig: BridgeConfig,
): Promise<Result<BridgeRuntimeConfig, ReloadCommitError>> {
  try {
    await running.reload(plan.nextConfig);
  } catch (commitError) {
    const originalCause =
      commitError instanceof Error ? commitError.message : String(commitError);
    try {
      await running.reload(previousConfig);
    } catch (rollbackError) {
      const rollbackCause =
        rollbackError instanceof Error
          ? rollbackError.message
          : String(rollbackError);
      return err({
        _tag: "ReloadRollbackFailed",
        originalCause,
        rollbackCause,
      });
    }
    return err({
      _tag: "ReloadCommitFailed",
      cause: originalCause,
      rolledBack: true,
    });
  }
  return ok(plan.nextRuntime);
}
