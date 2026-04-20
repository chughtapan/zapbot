/**
 * moltzap/supervisor — reconnect + backoff policy over the lifecycle attempt.
 *
 * Anchors: zap#134 architect plan (reconnect + backoff); zap#126 epic;
 * zap#128 staff PR (lifecycle with FAILED terminal); spec moltzap-channel-v1
 * §4 I7 (no durability/dedupe/buffering), §4 I3 (presence-gated delivery).
 *
 * Why this is a separate module, not an extension to lifecycle.ts:
 *
 *   - The lifecycle machine encodes a *single attempt*: INIT → LISTENING, or
 *     FAILED with a preserved `cause`. #128 committed to FAILED as terminal;
 *     bridge/listener gate on that invariant.
 *   - Reconnect is an *outer loop* over a sequence of fresh attempts. Pure
 *     supervision semantics (count, delay, give-up) belong outside the inner
 *     state algebra. OTP-style supervision: supervisor knows nothing about
 *     moltzap events, only attempt outcomes and wall-clock.
 *   - I7 compliance by construction: no SupervisorState tag carries a
 *     MoltzapInbound event, conversation id, or message id. Nothing survives
 *     the attempt boundary except counters and the give-up cause. Each new
 *     attempt starts from `INITIAL` lifecycle state.
 *
 * Backoff curve (AWS "Exponential Backoff And Jitter", full-jitter variant):
 *
 *     delayMs(attempt) = randomInt(0, min(capMs, initialMs * 2^attempt))
 *
 * Default `BackoffPolicy`: `{ initialMs: 1_000, capMs: 60_000, maxAttempts: 8 }`.
 * Max attempts is a *consecutive-failure* counter: reaching LISTENING resets
 * it. Intermediate progress (STDIO_READY, MOLTZAP_READY) does not reset —
 * a fail at listener-registration should count toward give-up.
 *
 * Clock is injected (`Clock`). Tests pass a virtual clock; runtime passes a
 * thin wrapper over `Date.now` + `setTimeout` + `Math.random`.
 */

import type { Result } from "../types.ts";
import type {
  DrainReason,
  LifecycleError,
  LifecycleState,
} from "./lifecycle.ts";

// ── Branded types ───────────────────────────────────────────────────

export type AttemptCount = number & { readonly __brand: "AttemptCount" };
export type DelayMs = number & { readonly __brand: "DelayMs" };
export type WallClockMs = number & { readonly __brand: "WallClockMs" };

export function asAttemptCount(n: number): AttemptCount {
  return n as AttemptCount;
}
export function asDelayMs(n: number): DelayMs {
  return n as DelayMs;
}
export function asWallClockMs(n: number): WallClockMs {
  return n as WallClockMs;
}

// ── Policy ──────────────────────────────────────────────────────────

/**
 * Static policy the supervisor reads every attempt. No runtime mutation.
 * `maxAttempts` is the consecutive-failure cap; reaching LISTENING resets
 * the counter to 0 inside `step()`.
 */
export interface BackoffPolicy {
  readonly initialMs: DelayMs;
  readonly capMs: DelayMs;
  readonly maxAttempts: AttemptCount;
}

/** Default policy. Initial=1s, cap=60s, max=8 consecutive failures. */
export const DEFAULT_POLICY: BackoffPolicy = {
  initialMs: 1_000 as DelayMs,
  capMs: 60_000 as DelayMs,
  maxAttempts: 8 as AttemptCount,
};

// ── Clock (injection point) ─────────────────────────────────────────

/**
 * Everything time-dependent goes through `Clock`. Supervisor is otherwise
 * a pure state function. Runtime `Clock` is a thin `Date.now`/`setTimeout`/
 * `Math.random` wrapper supplied at the plugin boot layer.
 */
export interface Clock {
  readonly now: () => WallClockMs;
  readonly randomJitter: (maxMs: DelayMs) => DelayMs;
}

// ── State ───────────────────────────────────────────────────────────

/**
 * Supervisor's view of the world. `Active` wraps the inner lifecycle —
 * `Active.lifecycle._tag === "LISTENING"` is the "bridge is up" probe.
 * `Backoff` is waiting-for-retry; the timer fires a `BackoffElapsed`.
 * `GaveUp` is terminal; the process should exit with the preserved cause.
 */
export type SupervisorState =
  | { readonly _tag: "Active"; readonly attempts: AttemptCount; readonly lifecycle: LifecycleState }
  | { readonly _tag: "Backoff"; readonly attempts: AttemptCount; readonly waitUntilMs: WallClockMs; readonly lastCause: LifecycleError }
  | { readonly _tag: "Draining"; readonly reason: DrainReason }
  | { readonly _tag: "GaveUp"; readonly cause: SupervisorGaveUp };

/**
 * Terminal supervisor error. Surfaced up to the plugin boot layer, which
 * logs, emits a shutdown telemetry event, and exits the process.
 */
export type SupervisorGaveUp =
  | { readonly _tag: "MaxAttemptsExhausted"; readonly attempts: AttemptCount; readonly lastCause: LifecycleError }
  | { readonly _tag: "DrainCompleted"; readonly reason: DrainReason };

// ── Events ──────────────────────────────────────────────────────────

/**
 * What the outer driver feeds the supervisor. `LifecycleProgressed` is the
 * inner state machine's output, re-projected upward. `BackoffElapsed` is the
 * scheduled timer firing. `DrainRequested` is external shutdown.
 */
export type SupervisorEvent =
  | { readonly _tag: "LifecycleProgressed"; readonly state: LifecycleState }
  | { readonly _tag: "BackoffElapsed" }
  | { readonly _tag: "DrainRequested"; readonly reason: DrainReason }
  | { readonly _tag: "Stopped" };

// ── Step output ─────────────────────────────────────────────────────

/**
 * `step()` returns the next `SupervisorState` plus a tagged action the
 * driver must perform. Actions are *descriptions*; the supervisor never
 * performs I/O or schedules timers itself. Principle 3: state is data, not
 * side effects.
 */
export type SupervisorAction =
  | { readonly _tag: "None" }
  | { readonly _tag: "StartAttempt"; readonly attempts: AttemptCount }
  | { readonly _tag: "ScheduleRetry"; readonly delayMs: DelayMs; readonly firesAtMs: WallClockMs }
  | { readonly _tag: "ReportGaveUp"; readonly cause: SupervisorGaveUp };

export type StepResult =
  | { readonly _tag: "Next"; readonly state: SupervisorState; readonly action: SupervisorAction }
  | { readonly _tag: "Illegal"; readonly from: SupervisorState; readonly event: SupervisorEvent };

// ── Initial state ───────────────────────────────────────────────────

export const INITIAL_SUPERVISOR: SupervisorState = {
  _tag: "Active",
  attempts: 0 as AttemptCount,
  lifecycle: { _tag: "INIT" },
};

// ── Public surface ──────────────────────────────────────────────────

/**
 * Pure delay computation. `delayMs = randomJitter(min(capMs, initialMs * 2^attempt))`.
 * Called by `step()` when transitioning into `Backoff`.
 */
export function computeBackoff(
  attempt: AttemptCount,
  policy: BackoffPolicy,
  clock: Clock,
): DelayMs {
  const exponentialCap = Number(policy.initialMs) * 2 ** Number(attempt);
  const maxDelay = Math.min(Number(policy.capMs), exponentialCap);
  const jitter = Number(clock.randomJitter(asDelayMs(maxDelay)));
  return asDelayMs(Math.min(Math.max(jitter, 0), maxDelay));
}

/**
 * Drive the supervisor one event forward. Returns the next state and the
 * action the driver must perform.
 *
 *   - `Active(lifecycle=FAILED)` + attempts < max → `Backoff` + `ScheduleRetry`.
 *   - `Active(lifecycle=FAILED)` + attempts >= max → `GaveUp(MaxAttemptsExhausted)`.
 *   - `Active(lifecycle=LISTENING)` → attempts reset to 0 (pure, same tag).
 *   - `Backoff` + `BackoffElapsed` → fresh `Active(INIT)` + `StartAttempt`.
 *   - Any state + `DrainRequested` → `Draining` (cancels outstanding timer).
 *   - `Draining` + `Stopped` → `GaveUp(DrainCompleted)`.
 *
 * Illegal pairs (e.g. `BackoffElapsed` from `Active`) return `Illegal`; the
 * driver decides whether to panic. Lifecycle's own `transition()` stays the
 * inner authority; supervisor only observes outcomes.
 */
export function step(
  from: SupervisorState,
  event: SupervisorEvent,
  policy: BackoffPolicy,
  clock: Clock,
): StepResult {
  if (from._tag !== "GaveUp" && event._tag === "DrainRequested") {
    return next({ _tag: "Draining", reason: event.reason }, { _tag: "None" });
  }

  switch (from._tag) {
    case "Active":
      if (event._tag !== "LifecycleProgressed") {
        return illegal(from, event);
      }
      return stepActive(from, event.state, policy, clock);
    case "Backoff":
      if (event._tag !== "BackoffElapsed") {
        return illegal(from, event);
      }
      return startFreshAttempt(from.attempts);
    case "Draining":
      if (event._tag !== "Stopped") {
        return illegal(from, event);
      }
      return gaveUp({
        _tag: "DrainCompleted",
        reason: from.reason,
      });
    case "GaveUp":
      return illegal(from, event);
    default:
      return absurd(from);
  }
}

/**
 * Readiness probe for the plugin boot layer and for bridge pre-condition
 * checks. True only when the inner lifecycle is `LISTENING`.
 */
export function supervisorIsListening(state: SupervisorState): boolean {
  return state._tag === "Active" && state.lifecycle._tag === "LISTENING";
}

/**
 * Terminal probe. True for `GaveUp`; the driver should exit the process.
 */
export function supervisorIsTerminal(state: SupervisorState): boolean {
  return state._tag === "GaveUp";
}

/**
 * Produce a fresh attempt's starting inputs: a new `INIT` lifecycle and
 * the incremented attempt counter. Called by `step()` when transitioning
 * `Backoff → Active` on `BackoffElapsed`.
 *
 * I7 enforcement: return value carries no message state, no conversation
 * id, no inbound event. Attempt boundary is a hard reset.
 */
export function freshAttempt(
  prevAttempts: AttemptCount,
): Result<{ readonly attempts: AttemptCount; readonly lifecycle: LifecycleState }, never> {
  return {
    _tag: "Ok",
    value: {
      attempts: asAttemptCount(Number(prevAttempts) + 1),
      lifecycle: { _tag: "INIT" },
    },
  };
}

function stepActive(
  from: Extract<SupervisorState, { readonly _tag: "Active" }>,
  lifecycle: LifecycleState,
  policy: BackoffPolicy,
  clock: Clock,
): StepResult {
  if (lifecycle._tag === "LISTENING") {
    return next(
      {
        _tag: "Active",
        attempts: asAttemptCount(0),
        lifecycle,
      },
      { _tag: "None" },
    );
  }

  if (lifecycle._tag !== "FAILED") {
    return next(
      {
        _tag: "Active",
        attempts: from.attempts,
        lifecycle,
      },
      { _tag: "None" },
    );
  }

  if (Number(from.attempts) >= Number(policy.maxAttempts) - 1) {
    return gaveUp({
      _tag: "MaxAttemptsExhausted",
      attempts: from.attempts,
      lastCause: lifecycle.cause,
    });
  }

  const delayMs = computeBackoff(from.attempts, policy, clock);
  const firesAtMs = asWallClockMs(Number(clock.now()) + Number(delayMs));
  return next(
    {
      _tag: "Backoff",
      attempts: from.attempts,
      waitUntilMs: firesAtMs,
      lastCause: lifecycle.cause,
    },
    {
      _tag: "ScheduleRetry",
      delayMs,
      firesAtMs,
    },
  );
}

function startFreshAttempt(
  prevAttempts: AttemptCount,
): StepResult {
  const nextAttempt = freshAttempt(prevAttempts);
  if (nextAttempt._tag !== "Ok") {
    return absurd(nextAttempt.error);
  }
  return next(
    {
      _tag: "Active",
      attempts: nextAttempt.value.attempts,
      lifecycle: nextAttempt.value.lifecycle,
    },
    {
      _tag: "StartAttempt",
      attempts: nextAttempt.value.attempts,
    },
  );
}

function next(state: SupervisorState, action: SupervisorAction): StepResult {
  return { _tag: "Next", state, action };
}

function illegal(from: SupervisorState, event: SupervisorEvent): StepResult {
  return { _tag: "Illegal", from, event };
}

function gaveUp(cause: SupervisorGaveUp): StepResult {
  return next(
    {
      _tag: "GaveUp",
      cause,
    },
    {
      _tag: "ReportGaveUp",
      cause,
    },
  );
}

function absurd(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
