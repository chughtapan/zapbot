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
 * OQ3 resolution: `checkBudget` returns the FIRST trip encountered;
 * `retireScopeFor` narrows to member-vs-roster. Two-gate independence
 * holds at the evaluation level (both gates are considered on every
 * `checkBudget` call), not at the return-shape level.
 *
 * This module is pure: data in, `BudgetVerdict` out. It performs no I/O,
 * schedules no timers, and writes no receipts.
 */

import type { AoSessionName, Result } from "../types.ts";
import { absurd, err, ok } from "../types.ts";

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

// ── State ───────────────────────────────────────────────────────────

interface BudgetStateInternal {
  readonly __brand: "BudgetState";
  readonly config: BudgetConfig;
  readonly lastPeerAtMs: ReadonlyMap<AoSessionName, WallClockMs>;
  readonly tokensConsumed: ReadonlyMap<AoSessionName, TokenCount>;
  readonly retired: ReadonlySet<AoSessionName>;
  readonly rosterTokensConsumed: TokenCount;
}

/**
 * Opaque roster-wide budget state. Callers never inspect internals.
 */
export interface BudgetState {
  readonly __brand: "BudgetState";
}

function asInternal(state: BudgetState): BudgetStateInternal {
  return state as BudgetStateInternal;
}

// ── Decoders ────────────────────────────────────────────────────────

const MAX_SAFE_NON_NEGATIVE = Number.MAX_SAFE_INTEGER;

function parsePositiveInt(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!/^[0-9]+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_SAFE_NON_NEGATIVE) return null;
  return n;
}

export function decodeBudgetConfigFromEnv(
  env: Record<string, string | undefined>,
  declaredMemberCount: number,
): Result<BudgetConfig, BudgetConfigDecodeError> {
  if (
    !Number.isInteger(declaredMemberCount) ||
    declaredMemberCount <= 0 ||
    declaredMemberCount > MAX_SAFE_NON_NEGATIVE
  ) {
    return err({ _tag: "InvalidMemberCount", raw: declaredMemberCount });
  }

  const rawIdle = env.MOLTZAP_SESSION_IDLE_SECONDS;
  let idle: IdleSeconds;
  if (rawIdle === undefined || rawIdle.trim().length === 0) {
    idle = DEFAULT_BUDGET_CONFIG.sessionIdleSeconds;
  } else {
    const parsed = parsePositiveInt(rawIdle);
    if (parsed === null) {
      return err({ _tag: "InvalidIdleSeconds", raw: rawIdle });
    }
    idle = parsed as IdleSeconds;
  }

  const rawTokens = env.MOLTZAP_ROSTER_BUDGET_TOKENS;
  let tokens: TokenCount;
  if (rawTokens === undefined || rawTokens.trim().length === 0) {
    tokens = DEFAULT_BUDGET_CONFIG.rosterBudgetTokens;
  } else {
    const parsed = parsePositiveInt(rawTokens);
    if (parsed === null) {
      return err({ _tag: "InvalidRosterTokens", raw: rawTokens });
    }
    tokens = parsed as TokenCount;
  }

  return ok({
    sessionIdleSeconds: idle,
    rosterBudgetTokens: tokens,
    declaredMemberCount,
  });
}

// ── State transitions ──────────────────────────────────────────────

export function initialBudgetState(
  config: BudgetConfig,
  members: readonly AoSessionName[],
  nowMs: WallClockMs,
): BudgetState {
  const lastPeerAtMs = new Map<AoSessionName, WallClockMs>();
  const tokensConsumed = new Map<AoSessionName, TokenCount>();
  for (const m of members) {
    lastPeerAtMs.set(m, nowMs);
    tokensConsumed.set(m, 0 as TokenCount);
  }
  const internal: BudgetStateInternal = {
    __brand: "BudgetState",
    config,
    lastPeerAtMs,
    tokensConsumed,
    retired: new Set<AoSessionName>(),
    rosterTokensConsumed: 0 as TokenCount,
  };
  return internal as BudgetState;
}

export function applyBudgetEvent(state: BudgetState, event: BudgetEvent): BudgetState {
  const s = asInternal(state);
  switch (event._tag) {
    case "PeerMessageObserved": {
      if (!s.lastPeerAtMs.has(event.session)) return state;
      if (s.retired.has(event.session)) return state;
      const next = new Map(s.lastPeerAtMs);
      next.set(event.session, event.atMs);
      return {
        ...s,
        lastPeerAtMs: next,
      } as BudgetState;
    }
    case "TokensConsumed": {
      if (!s.tokensConsumed.has(event.session)) return state;
      if (s.retired.has(event.session)) return state;
      const prior = (s.tokensConsumed.get(event.session) ?? 0) as number;
      const next = new Map(s.tokensConsumed);
      next.set(event.session, (prior + (event.tokens as number)) as TokenCount);
      const rosterNext = ((s.rosterTokensConsumed as number) +
        (event.tokens as number)) as TokenCount;
      return {
        ...s,
        tokensConsumed: next,
        rosterTokensConsumed: rosterNext,
      } as BudgetState;
    }
    case "MemberRetired": {
      if (!s.lastPeerAtMs.has(event.session)) return state;
      if (s.retired.has(event.session)) return state;
      const retired = new Set(s.retired);
      retired.add(event.session);
      return { ...s, retired } as BudgetState;
    }
    default:
      return absurd(event);
  }
}

export function checkBudget(state: BudgetState, nowMs: WallClockMs): BudgetVerdict {
  const s = asInternal(state);

  // Roster-token gate first? No — OQ3 resolution: first-trip ordering.
  // We evaluate both gates in a deterministic order: roster-token, then
  // per-session idle. The order is documented but not semantic — two-gate
  // independence means either trip is sufficient (Invariant 6).

  if ((s.rosterTokensConsumed as number) >= (s.config.rosterBudgetTokens as number)) {
    return {
      _tag: "RosterTokenBudgetTripped",
      consumedTokens: s.rosterTokensConsumed,
      ceilingTokens: s.config.rosterBudgetTokens,
    };
  }

  const idleCeilingMs = (s.config.sessionIdleSeconds as number) * 1000;
  let worstSession: AoSessionName | null = null;
  let worstIdleMs = -1;
  for (const [session, lastAt] of s.lastPeerAtMs) {
    if (s.retired.has(session)) continue;
    const idleMs = (nowMs as number) - (lastAt as number);
    if (idleMs >= idleCeilingMs && idleMs > worstIdleMs) {
      worstSession = session;
      worstIdleMs = idleMs;
    }
  }
  if (worstSession !== null) {
    return {
      _tag: "IdleTimeoutTripped",
      session: worstSession,
      idleForMs: worstIdleMs,
    };
  }

  return { _tag: "WithinBudget" };
}

export function retireScopeFor(verdict: BudgetVerdict): {
  readonly _tag: "None" | "RetireMember" | "RetireRoster";
  readonly session: AoSessionName | null;
} {
  switch (verdict._tag) {
    case "WithinBudget":
      return { _tag: "None", session: null };
    case "IdleTimeoutTripped":
      return { _tag: "RetireMember", session: verdict.session };
    case "RosterTokenBudgetTripped":
      return { _tag: "RetireRoster", session: null };
    default:
      return absurd(verdict);
  }
}
