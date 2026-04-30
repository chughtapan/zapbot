/**
 * orchestrator/runtime — bridge-side coordinator that folds MoltZap
 * ingress events and a periodic tick into the RosterManager's two-gate
 * budget state machine (SPEC §5(g)).
 *
 * The bridge dispatches to the persistent zapbot orchestrator process via
 * `POST /turn`. Roster budget enforcement is preserved so downstream code
 * that observes ingress events keeps compiling; once roster-spawn is gone
 * too the whole module retires.
 */

import type { AoSessionName } from "../types.ts";
import type { RosterId, RosterManager } from "./roster.ts";
import { asWallClockMs, asTokenCount } from "./budget.ts";
import type { TokenCount } from "./budget.ts";

export interface RosterBudgetTickOutcome {
  readonly rosterId: RosterId;
  readonly outcomeTag: string;
}

/**
 * Bridge-side coordinator that folds MoltZap ingress events + an
 * interval tick into the RosterManager's budget state machine.
 */
export interface RosterBudgetCoordinator {
  readonly observeInboundPeerMessage: (args: {
    readonly session: AoSessionName;
    readonly atMs: number;
  }) => void;
  readonly observeTokensConsumed: (args: {
    readonly session: AoSessionName;
    readonly tokens: number;
  }) => void;
  readonly tickAllBudgets: (nowMs?: number) => Promise<readonly RosterBudgetTickOutcome[]>;
  readonly startPeriodicTick: (intervalMs: number) => () => void;
}

export function createRosterBudgetCoordinator(
  manager: RosterManager,
  nowFn: () => number = Date.now,
): RosterBudgetCoordinator {
  function observeInboundPeerMessage(args: {
    readonly session: AoSessionName;
    readonly atMs: number;
  }): void {
    const rosterId = manager.findRosterForSession(args.session);
    if (rosterId === null) return;
    manager.recordPeerMessageObserved(
      rosterId,
      args.session,
      asWallClockMs(args.atMs),
    );
  }

  function observeTokensConsumed(args: {
    readonly session: AoSessionName;
    readonly tokens: number;
  }): void {
    const rosterId = manager.findRosterForSession(args.session);
    if (rosterId === null) return;
    const tokens: TokenCount = asTokenCount(Math.max(0, Math.floor(args.tokens)));
    manager.recordTokensConsumed(rosterId, args.session, tokens);
  }

  async function tickAllBudgets(
    nowMs?: number,
  ): Promise<readonly RosterBudgetTickOutcome[]> {
    const t = asWallClockMs(nowMs ?? nowFn());
    const ids = manager.listActiveRosterIds();
    const outcomes = await Promise.all(
      ids.map(async (rosterId) => {
        const outcome = await manager.stepBudget(rosterId, t);
        return { rosterId, outcomeTag: outcome._tag };
      }),
    );
    return outcomes;
  }

  function startPeriodicTick(intervalMs: number): () => void {
    const handle = setInterval(() => {
      void tickAllBudgets();
    }, intervalMs);
    return () => clearInterval(handle);
  }

  return {
    observeInboundPeerMessage,
    observeTokensConsumed,
    tickAllBudgets,
    startPeriodicTick,
  };
}

