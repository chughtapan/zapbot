/**
 * orchestrator/budget — two-gate termination: idle wall-clock + roster-level
 * Claude-token ceiling.
 *
 * Anchors: SPEC r4.1 (https://github.com/chughtapan/safer-by-default/issues/145#issuecomment-4307793815)
 *   Goal 7; Acceptance (g); Invariant 6 (two-gate independence).
 *
 * Gates:
 *   1. `MOLTZAP_SESSION_IDLE_SECONDS` (default 600) — per-session wall-clock
 *      since the last MoltZap peer-channel event (Q1 resolution: MoltZap
 *      events only reset the clock; GitHub / model-internal turns do not).
 *   2. `MOLTZAP_ROSTER_BUDGET_TOKENS` (default 1_000_000) — per-roster sum of
 *      Claude tokens across all member sessions. Per-session accounting is
 *      the ceiling divided equally across declared member count (Q3).
 *
 * Invariant 6: the gates are independent. Either tripping is sufficient to
 * terminate. Neither subsumes the other.
 *
 * Trip semantics (Acceptance (g) bullets 3-4):
 *   - `IdleTimeoutTripped`  → caller retires ONLY the stalled member.
 *   - `RosterTokenBudgetTripped` → caller retires the entire roster.
 *
 * This module is pure: data in, `BudgetVerdict` out. It performs no I/O,
 * schedules no timers, and writes no receipts. The roster manager owns
 * `retireMember` / `retireRoster`; this module owns only the verdict.
 *
 * Architect phase only: public surface, no implementation.
 */

import type { AoSessionName, Result } from "../types.ts";

// ── Branded scalars ─────────────────────────────────────────────────

export type IdleSeconds = number & { readonly __brand: "IdleSeconds" };
export type TokenCount = number & { readonly __brand: "TokenCount" };
export type WallClockMs = number & { readonly __brand: "WallClockMs" };

export function asIdleSeconds(n: number): IdleSeconds {
  return n as IdleSeconds;
}
export function asTokenCount(n: number): TokenCount {
  return n as TokenCount;
}
export function asWallClockMs(n: number): WallClockMs {
  return n as WallClockMs;
}

// ── Config ──────────────────────────────────────────────────────────

export interface BudgetConfig {
  readonly sessionIdleSeconds: IdleSeconds;
  readonly rosterBudgetTokens: TokenCount;
  /**
   * Declared member count at dispatch time. Per-session accounting is
   * `rosterBudgetTokens / declaredMemberCount` (Q3). Non-mutable for the
   * lifetime of the roster.
   */
  readonly declaredMemberCount: number;
}

export const DEFAULT_BUDGET_CONFIG: Pick<
  BudgetConfig,
  "sessionIdleSeconds" | "rosterBudgetTokens"
> = {
  sessionIdleSeconds: 600 as IdleSeconds,
  rosterBudgetTokens: 1_000_000 as TokenCount,
};

export type BudgetConfigDecodeError =
  | { readonly _tag: "InvalidIdleSeconds"; readonly raw: string }
  | { readonly _tag: "InvalidRosterTokens"; readonly raw: string }
  | { readonly _tag: "InvalidMemberCount"; readonly raw: number };

// ── Events the state machine consumes ──────────────────────────────

export type BudgetEvent =
  | {
      readonly _tag: "PeerMessageObserved";
      readonly session: AoSessionName;
      readonly atMs: WallClockMs;
    }
  | {
      readonly _tag: "TokensConsumed";
      readonly session: AoSessionName;
      readonly tokens: TokenCount;
    }
  | {
      readonly _tag: "MemberRetired";
      readonly session: AoSessionName;
      readonly atMs: WallClockMs;
    };

// ── Verdicts ────────────────────────────────────────────────────────

export type BudgetVerdict =
  | { readonly _tag: "WithinBudget" }
  | {
      readonly _tag: "IdleTimeoutTripped";
      readonly session: AoSessionName;
      readonly idleForMs: number;
    }
  | {
      readonly _tag: "RosterTokenBudgetTripped";
      readonly consumedTokens: TokenCount;
      readonly ceilingTokens: TokenCount;
    };

// ── State (opaque) ──────────────────────────────────────────────────

/**
 * Opaque roster-wide budget state. Holds:
 *   - per-session last-peer-event wall-clock,
 *   - per-session token consumption,
 *   - roster-wide token sum,
 *   - per-session retired flag.
 *
 * Callers never inspect internals. Only `initialBudgetState` /
 * `applyBudgetEvent` / `checkBudget` touch it.
 */
export interface BudgetState {
  readonly __brand: "BudgetState";
}

// ── Public surface ──────────────────────────────────────────────────

/**
 * Decode `BudgetConfig` from an env-like record. Principle 2.
 * `declaredMemberCount` comes from the roster spec, not env.
 */
export function decodeBudgetConfigFromEnv(
  env: Record<string, string | undefined>,
  declaredMemberCount: number,
): Result<BudgetConfig, BudgetConfigDecodeError> {
  throw new Error("not implemented");
}

/**
 * Construct a fresh `BudgetState` at roster-spawn time. `nowMs` seeds the
 * last-peer-event clock for every session to `nowMs`, so a session that
 * never sends a peer event trips idle-timeout `sessionIdleSeconds` after
 * spawn (Acceptance (g) bullet 1).
 */
export function initialBudgetState(
  config: BudgetConfig,
  members: readonly AoSessionName[],
  nowMs: WallClockMs,
): BudgetState {
  throw new Error("not implemented");
}

/**
 * Fold a `BudgetEvent` into the state. Pure; returns a new state reference.
 * Unknown sessions are a no-op (retired-and-forgotten guard).
 */
export function applyBudgetEvent(state: BudgetState, event: BudgetEvent): BudgetState {
  throw new Error("not implemented");
}

/**
 * Evaluate both gates against the given wall-clock. Returns the FIRST trip
 * encountered (implementation chooses ordering). If neither trips,
 * `WithinBudget`. Invariant 6: both gates are checked; neither subsumes the
 * other.
 */
export function checkBudget(state: BudgetState, nowMs: WallClockMs): BudgetVerdict {
  throw new Error("not implemented");
}

/**
 * Narrow a verdict to the per-session action the roster manager must take.
 * Principle 4: exhaustive over the `BudgetVerdict` union.
 */
export function retireScopeFor(verdict: BudgetVerdict): {
  readonly _tag: "None" | "RetireMember" | "RetireRoster";
  readonly session: AoSessionName | null;
} {
  throw new Error("not implemented");
}
