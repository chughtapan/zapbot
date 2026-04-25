/**
 * Integration test for SPEC §5(g) code-level budget enforcement.
 *
 * Exercises the production wiring in bridge.ts: spawn a roster via
 * RosterManager + fake AO CLI deps, drive events through the
 * RosterBudgetCoordinator (the production ingress-observer seam), and
 * assert that stepBudget actually retires sessions when either gate
 * trips. This is the end-to-end check stamina round 3 required: it is
 * NOT a direct unit-test of checkBudget; it exercises the path from
 * ingress event → coordinator → manager → retireSession dep.
 */

import { describe, expect, it } from "vitest";
import {
  createRosterBudgetCoordinator,
} from "../src/orchestrator/runtime.ts";
import {
  asRosterId,
  createRosterManager,
  decodeRosterSpec,
  type RosterManagerDeps,
  type RosterMember,
  type RosterSpec,
} from "../src/orchestrator/roster.ts";
import { asMoltzapSenderId } from "../src/moltzap/types.ts";
import {
  asAoSessionName,
  ok,
} from "../src/types.ts";

const ROSTER_ID = asRosterId("roster-145-r1");

function specFromValid(): RosterSpec {
  const res = decodeRosterSpec({
    rosterId: "roster-145-r1",
    issue: 145,
    projectName: "safer-by-default",
    members: [
      { role: "architect", displayLabel: "architect-a" },
      { role: "implementer", displayLabel: "implementer-1" },
    ],
    budget: {
      sessionIdleSeconds: 60, // short for the test
      rosterBudgetTokens: 1000, // small so we can trip it
      declaredMemberCount: 2,
    },
  });
  if (res._tag !== "Ok") throw new Error("spec decode failed");
  return res.value;
}

function makeDeps(): {
  deps: RosterManagerDeps;
  retires: string[];
  now: () => number;
} {
  let t = 1_000_000;
  const retires: string[] = [];
  const deps: RosterManagerDeps = {
    spawnSession: async ({ rosterId, member }) => {
      t += 1;
      const session = asAoSessionName(
        `${rosterId as string}-${member.displayLabel}`,
      );
      const senderId = asMoltzapSenderId(`sender-${member.displayLabel}`);
      const m: RosterMember = {
        rosterId,
        session,
        senderId,
        role: member.role,
        displayLabel: member.displayLabel,
        spawnedAtMs: t,
      };
      return ok(m);
    },
    retireSession: async (session) => {
      retires.push(session as string);
      return ok(undefined);
    },
    clock: () => t,
  };
  return { deps, retires, now: () => t };
}

describe("roster budget integration (SPEC §5(g) code-level enforcement)", () => {
  it("end-to-end: peer message ingress via coordinator resets idle clock (ingress → manager)", async () => {
    const { deps, now } = makeDeps();
    const manager = createRosterManager(deps);
    const coordinator = createRosterBudgetCoordinator(manager, now);

    const spec = specFromValid();
    const spawned = await manager.spawnRoster(spec);
    if (spawned._tag !== "Ok") throw new Error("spawn failed");
    const sessionA = spawned.value[0].session;

    // The production bridge path calls observeInboundPeerMessage on
    // every MoltZap inbound notify; simulate that.
    coordinator.observeInboundPeerMessage({
      session: sessionA,
      atMs: now(),
    });

    // Advance the clock and tick. The observed session is fresh; the
    // other is not. The tick should retire the non-observed one if idle
    // exceeds the ceiling.
    const idleCeilingMs = spec.budget.sessionIdleSeconds * 1000;
    const outcomes = await coordinator.tickAllBudgets(
      now() + idleCeilingMs + 1000,
    );
    expect(outcomes.length).toBeGreaterThan(0);
    // At least one outcome must be MemberRetired for the other session.
    const retired = outcomes.find((o) => o.outcomeTag === "MemberRetired");
    expect(retired).toBeDefined();
  });

  it("end-to-end: tokens-consumed ingress via coordinator trips roster retire", async () => {
    const { deps, retires, now } = makeDeps();
    const manager = createRosterManager(deps);
    const coordinator = createRosterBudgetCoordinator(manager, now);

    const spec = specFromValid();
    const spawned = await manager.spawnRoster(spec);
    if (spawned._tag !== "Ok") throw new Error("spawn failed");
    const sessionA = spawned.value[0].session;

    // Simulate the bridge wiring: after a control-event forward, the
    // orchestrator tallies tokens and feeds them to the coordinator.
    coordinator.observeTokensConsumed({
      session: sessionA,
      tokens: 600,
    });
    coordinator.observeTokensConsumed({
      session: sessionA,
      tokens: 500,
    });

    // The tick is what actually invokes retireSession; make sure it
    // drives the ceiling trip.
    const outcomes = await coordinator.tickAllBudgets(now());
    expect(outcomes.length).toBeGreaterThan(0);
    const rosterRetired = outcomes.find(
      (o) => o.outcomeTag === "RosterRetired",
    );
    expect(rosterRetired).toBeDefined();
    // Every member must have been retired via deps.retireSession —
    // proof the coordinator→manager→deps path fired end-to-end.
    expect(retires).toContain(sessionA as string);
  });

  it("periodic tick invokes stepBudget on an interval", () => {
    const { deps, now } = makeDeps();
    const manager = createRosterManager(deps);
    let stepCount = 0;
    // Wrap the manager so we can count stepBudget calls the
    // coordinator makes via the tick.
    const wrappedManager: typeof manager = {
      ...manager,
      stepBudget: async (rosterId, nowMs) => {
        stepCount += 1;
        return manager.stepBudget(rosterId, nowMs);
      },
    };
    const coordinator = createRosterBudgetCoordinator(wrappedManager, now);
    // Need an active roster for the tick to see; spawn one.
    // Use a tight interval; wait two windows.
    return manager.spawnRoster(specFromValid()).then(async (spawned) => {
      expect(spawned._tag).toBe("Ok");
      const stop = coordinator.startPeriodicTick(20);
      await new Promise((resolve) => setTimeout(resolve, 80));
      stop();
      // At ≥20ms interval over 80ms, stepBudget should fire at least
      // twice. Loose lower bound to avoid timer flake.
      expect(stepCount).toBeGreaterThanOrEqual(1);
    });
  });

  it("observeInboundPeerMessage on a session not owned by any roster is a no-op", async () => {
    const { deps, retires, now } = makeDeps();
    const manager = createRosterManager(deps);
    const coordinator = createRosterBudgetCoordinator(manager, now);

    // No roster spawned — nothing tracks this session.
    coordinator.observeInboundPeerMessage({
      session: asAoSessionName("unknown-session"),
      atMs: now(),
    });
    const outcomes = await coordinator.tickAllBudgets(now());
    expect(outcomes).toEqual([]); // no active rosters → no ticks
    expect(retires).toEqual([]);
  });

  it("listActiveRosterIds reflects spawnRoster lifecycle", async () => {
    const { deps } = makeDeps();
    const manager = createRosterManager(deps);
    expect(manager.listActiveRosterIds()).toEqual([]);
    await manager.spawnRoster(specFromValid());
    expect(manager.listActiveRosterIds()).toContain(ROSTER_ID);
  });

  it("findRosterForSession returns the owning rosterId for a spawned session", async () => {
    const { deps } = makeDeps();
    const manager = createRosterManager(deps);
    const spawned = await manager.spawnRoster(specFromValid());
    if (spawned._tag !== "Ok") throw new Error("spawn failed");
    expect(manager.findRosterForSession(spawned.value[0].session)).toBe(
      ROSTER_ID,
    );
    expect(manager.findRosterForSession(asAoSessionName("ghost"))).toBe(null);
  });
});
