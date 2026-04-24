import { describe, expect, it } from "vitest";
import {
  asRosterId,
  createRosterManager,
  decodeRosterSpec,
  resolveRetiredRecipientRoute,
  resolveSpawnPeers,
  type RosterManager,
  type RosterManagerDeps,
  type RosterMember,
  type RosterSpec,
} from "../src/orchestrator/roster.ts";
import {
  asIdleSeconds,
  asTokenCount,
  asWallClockMs,
} from "../src/orchestrator/budget.ts";
import {
  fromSenderIds,
} from "../src/moltzap/identity-allowlist.ts";
import { asMoltzapSenderId } from "../src/moltzap/types.ts";
import {
  asAoSessionName,
  asIssueNumber,
  asProjectName,
  ok,
  err,
} from "../src/types.ts";

const ID = asRosterId("roster-145-r1");

function validSpec(): unknown {
  return {
    rosterId: "roster-145-r1",
    issue: 145,
    projectName: "safer-by-default",
    members: [
      { role: "architect", displayLabel: "architect-a" },
      { role: "architect", displayLabel: "architect-b" },
      { role: "implementer", displayLabel: "implementer-1" },
      { role: "reviewer", displayLabel: "reviewer-1" },
    ],
    budget: {
      sessionIdleSeconds: 600,
      rosterBudgetTokens: 1_000_000,
      declaredMemberCount: 4,
    },
  };
}

describe("roster.decodeRosterSpec", () => {
  it("decodes a valid spec", () => {
    const res = decodeRosterSpec(validSpec());
    expect(res._tag).toBe("Ok");
  });

  it("rejects non-object input", () => {
    const res = decodeRosterSpec("not an object");
    expect(res._tag).toBe("Err");
    if (res._tag !== "Err") return;
    expect(res.error._tag).toBe("RosterSpecShapeInvalid");
  });

  it("rejects an empty members array", () => {
    const s = validSpec() as Record<string, unknown>;
    s.members = [];
    const res = decodeRosterSpec(s);
    expect(res._tag).toBe("Err");
    if (res._tag !== "Err") return;
    expect(res.error._tag).toBe("RosterMembersEmpty");
  });

  it("rejects duplicate displayLabels", () => {
    const s = validSpec() as Record<string, unknown>;
    s.members = [
      { role: "architect", displayLabel: "dup" },
      { role: "reviewer", displayLabel: "dup" },
    ];
    (s.budget as { declaredMemberCount: number }).declaredMemberCount = 2;
    const res = decodeRosterSpec(s);
    expect(res._tag).toBe("Err");
    if (res._tag !== "Err") return;
    expect(res.error._tag).toBe("RosterDuplicateLabel");
  });

  it("rejects a member with an unknown role", () => {
    const s = validSpec() as Record<string, unknown>;
    s.members = [{ role: "captain", displayLabel: "x" }];
    const res = decodeRosterSpec(s);
    expect(res._tag).toBe("Err");
    if (res._tag !== "Err") return;
    expect(res.error._tag).toBe("RosterMemberRoleUnknown");
  });

  it("rejects orchestrator as a member role (only worker roles allowed)", () => {
    const s = validSpec() as Record<string, unknown>;
    s.members = [{ role: "orchestrator", displayLabel: "x" }];
    const res = decodeRosterSpec(s);
    expect(res._tag).toBe("Err");
    if (res._tag !== "Err") return;
    expect(res.error._tag).toBe("RosterMemberRoleUnknown");
  });

  it("rejects a non-integer issue", () => {
    const s = validSpec() as Record<string, unknown>;
    s.issue = "one-forty-five";
    const res = decodeRosterSpec(s);
    expect(res._tag).toBe("Err");
  });
});

// ── RosterManager integration via fake deps ────────────────────────

interface FakeSpawnConfig {
  readonly failAfter?: number; // fail on the Nth spawn (0-indexed)
  readonly failWithReservedKey?: number; // index at which to emit ReservedMcpKeyCollision
  readonly retireFailures?: ReadonlySet<string>; // sessions that cannot be retired cleanly
}

function makeDeps(cfg: FakeSpawnConfig = {}): {
  deps: RosterManagerDeps;
  events: {
    spawns: string[];
    retires: string[];
  };
} {
  const events = { spawns: [] as string[], retires: [] as string[] };
  let spawnIndex = 0;
  let now = 1_000_000;

  const deps: RosterManagerDeps = {
    spawnSession: async ({ rosterId, member }) => {
      const i = spawnIndex++;
      events.spawns.push(member.displayLabel);
      if (cfg.failWithReservedKey === i) {
        return err({
          _tag: "ReservedMcpKeyCollision",
          key: "moltzap",
          member: { role: member.role, displayLabel: member.displayLabel },
        });
      }
      if (cfg.failAfter === i) {
        return err({
          _tag: "MemberSpawnFailed",
          role: member.role,
          displayLabel: member.displayLabel,
          cause: "simulated spawn failure",
        });
      }
      const session = asAoSessionName(`${rosterId as string}-${member.displayLabel}`);
      const senderId = asMoltzapSenderId(`sender-${member.displayLabel}`);
      now += 1;
      const rosterMember: RosterMember = {
        rosterId,
        session,
        senderId,
        role: member.role,
        displayLabel: member.displayLabel,
        spawnedAtMs: now,
      };
      return ok(rosterMember);
    },
    retireSession: async (session) => {
      events.retires.push(session as string);
      if (cfg.retireFailures && cfg.retireFailures.has(session as string)) {
        return err({
          _tag: "RetireReleaseFailed",
          cause: `release failed for ${session as string}`,
        });
      }
      return ok(undefined);
    },
    bindAllowlistFor: () => ok(fromSenderIds([])),
    clock: () => now,
  };

  return { deps, events };
}

function specFromValid(): RosterSpec {
  const res = decodeRosterSpec(validSpec());
  if (res._tag !== "Ok") throw new Error("spec failed to decode");
  return res.value;
}

describe("roster.spawnRoster", () => {
  it("spawns all members in order on the happy path", async () => {
    const { deps, events } = makeDeps();
    const mgr: RosterManager = createRosterManager(deps);
    const res = await mgr.spawnRoster(specFromValid());
    expect(res._tag).toBe("Ok");
    if (res._tag !== "Ok") return;
    expect(res.value).toHaveLength(4);
    expect(events.spawns).toEqual([
      "architect-a",
      "architect-b",
      "implementer-1",
      "reviewer-1",
    ]);
    expect(events.retires).toEqual([]);
  });

  it("rolls back previously spawned members on a mid-sequence failure", async () => {
    const { deps, events } = makeDeps({ failAfter: 2 });
    const mgr = createRosterManager(deps);
    const res = await mgr.spawnRoster(specFromValid());
    expect(res._tag).toBe("Err");
    if (res._tag !== "Err") return;
    expect(res.error._tag).toBe("PartialSpawnRolledBack");
    // Already-spawned members got retireSession called for cleanup.
    expect(events.retires).toEqual([
      "roster-145-r1-architect-a",
      "roster-145-r1-architect-b",
    ]);
  });

  it("emits MemberSpawnFailed (not PartialSpawnRolledBack) on first-member failure", async () => {
    const { deps } = makeDeps({ failAfter: 0 });
    const mgr = createRosterManager(deps);
    const res = await mgr.spawnRoster(specFromValid());
    expect(res._tag).toBe("Err");
    if (res._tag !== "Err") return;
    expect(res.error._tag).toBe("MemberSpawnFailed");
  });

  it("emits ReservedMcpKeyCollision for the moltzap reserved key", async () => {
    const { deps } = makeDeps({ failWithReservedKey: 1 });
    const mgr = createRosterManager(deps);
    const res = await mgr.spawnRoster(specFromValid());
    expect(res._tag).toBe("Err");
    if (res._tag !== "Err") return;
    expect(res.error._tag).toBe("ReservedMcpKeyCollision");
    if (res.error._tag !== "ReservedMcpKeyCollision") return;
    expect(res.error.key).toBe("moltzap");
  });
});

describe("roster.retireMember (idempotent)", () => {
  it("retires a live member and flips status to Retired", async () => {
    const { deps } = makeDeps();
    const mgr = createRosterManager(deps);
    const spawned = await mgr.spawnRoster(specFromValid());
    if (spawned._tag !== "Ok") throw new Error("setup failure");
    const member = spawned.value[0];

    const r1 = await mgr.retireMember(ID, member.session, { _tag: "ExplicitRetire" });
    expect(r1._tag).toBe("Ok");

    const tracked = await mgr.trackRoster(ID);
    if (tracked._tag !== "Ok") throw new Error("track failure");
    const status = tracked.value.find((s) => s.member.session === member.session);
    expect(status?._tag).toBe("Retired");
  });

  it("is idempotent: retiring again returns Ok without re-invoking retireSession", async () => {
    const { deps, events } = makeDeps();
    const mgr = createRosterManager(deps);
    const spawned = await mgr.spawnRoster(specFromValid());
    if (spawned._tag !== "Ok") throw new Error("setup failure");
    const member = spawned.value[0];

    await mgr.retireMember(ID, member.session, { _tag: "ExplicitRetire" });
    const retiresBefore = events.retires.length;
    const r2 = await mgr.retireMember(ID, member.session, { _tag: "TaskComplete" });
    expect(r2._tag).toBe("Ok");
    expect(events.retires.length).toBe(retiresBefore); // no extra retire call
  });

  it("returns SessionNotFound for an unknown session", async () => {
    const { deps } = makeDeps();
    const mgr = createRosterManager(deps);
    await mgr.spawnRoster(specFromValid());
    const res = await mgr.retireMember(
      ID,
      asAoSessionName("ghost"),
      { _tag: "ExplicitRetire" },
    );
    expect(res._tag).toBe("Err");
    if (res._tag !== "Err") return;
    expect(res.error._tag).toBe("SessionNotFound");
  });
});

describe("roster.retireRoster", () => {
  it("retires every live member", async () => {
    const { deps, events } = makeDeps();
    const mgr = createRosterManager(deps);
    await mgr.spawnRoster(specFromValid());
    const res = await mgr.retireRoster(ID, { _tag: "TaskComplete" });
    expect(res._tag).toBe("Ok");
    expect(events.retires).toHaveLength(4);
  });

  it("returns RosterNotFound for an unknown roster", async () => {
    const { deps } = makeDeps();
    const mgr = createRosterManager(deps);
    const res = await mgr.retireRoster(
      asRosterId("never-spawned"),
      { _tag: "ExplicitRetire" },
    );
    expect(res._tag).toBe("Err");
    if (res._tag !== "Err") return;
    expect(res.error._tag).toBe("RosterNotFound");
  });
});

describe("roster.resolveSpawnPeers", () => {
  it("includes only already-spawned members, grouped by role", () => {
    const spec = specFromValid();
    const spawned: RosterMember[] = [
      {
        rosterId: ID,
        session: asAoSessionName("sess-a"),
        senderId: asMoltzapSenderId("sender-a"),
        role: "architect",
        displayLabel: "architect-a",
        spawnedAtMs: 0,
      },
    ];
    const peers = resolveSpawnPeers(spec, spawned, {
      role: "architect",
      displayLabel: "architect-b",
    });
    expect(peers.get("architect")).toEqual([asMoltzapSenderId("sender-a")]);
    expect(peers.get("implementer")).toEqual([]);
    expect(peers.get("reviewer")).toEqual([]);
  });
});

describe("roster.resolveRetiredRecipientRoute", () => {
  it("routes any retired recipient to the orchestrator (Invariant 9)", () => {
    const orchestrator = asMoltzapSenderId("sender-o");
    const route = resolveRetiredRecipientRoute([], orchestrator);
    expect(route.orchestrator).toBe(orchestrator);
  });
});

describe("roster.retireMember TOCTOU (stamina round 3 #8)", () => {
  it("overlapping retireMember calls do NOT double-invoke deps.retireSession", async () => {
    const { deps, events } = makeDeps();
    const mgr = createRosterManager(deps);
    const spawned = await mgr.spawnRoster(specFromValid());
    if (spawned._tag !== "Ok") throw new Error("spawn failed");
    const session = spawned.value[0].session;

    // Fire two concurrent retires; the claim-and-mark-retired-before-
    // await pattern must let the second see Retired and short-circuit.
    const [r1, r2] = await Promise.all([
      mgr.retireMember(ID, session, { _tag: "ExplicitRetire" }),
      mgr.retireMember(ID, session, { _tag: "TaskComplete" }),
    ]);
    expect(r1._tag).toBe("Ok");
    expect(r2._tag).toBe("Ok");
    // deps.retireSession must have been called EXACTLY ONCE for this
    // session — double-retire would push two entries.
    const retiresForSession = events.retires.filter(
      (s) => s === (session as string),
    );
    expect(retiresForSession).toHaveLength(1);
  });

  it("overlapping stepBudget+retireMember calls are also safe", async () => {
    const { deps, events } = makeDeps();
    const mgr = createRosterManager(deps);
    const spec = specFromValid();
    const spawned = await mgr.spawnRoster(spec);
    if (spawned._tag !== "Ok") throw new Error("spawn failed");
    const session = spawned.value[0].session;

    // Advance time past the idle ceiling.
    const t0 = deps.clock();
    const future = asWallClockMs(t0 + spec.budget.sessionIdleSeconds * 1000 + 100);

    // Fire stepBudget (which will retire) concurrently with an explicit
    // retire for the same session.
    const [stepResult, retireResult] = await Promise.all([
      mgr.stepBudget(ID, future),
      mgr.retireMember(ID, session, { _tag: "ExplicitRetire" }),
    ]);
    expect(retireResult._tag).toBe("Ok");
    expect(["MemberRetired", "WithinBudget"]).toContain(stepResult._tag);
    // deps.retireSession fired exactly once for this session.
    const retiresForSession = events.retires.filter(
      (s) => s === (session as string),
    );
    expect(retiresForSession.length).toBeLessThanOrEqual(1);
  });
});

describe("roster budget wiring (SPEC §5(g) code-level enforcement)", () => {
  it("stepBudget returns WithinBudget immediately after spawn", async () => {
    const { deps } = makeDeps();
    const mgr = createRosterManager(deps);
    await mgr.spawnRoster(specFromValid());
    const outcome = await mgr.stepBudget(ID, asWallClockMs(deps.clock()));
    expect(outcome._tag).toBe("WithinBudget");
  });

  it("stepBudget trips RetireMember when a session idles past the ceiling", async () => {
    const { deps } = makeDeps();
    const mgr = createRosterManager(deps);
    const spawned = await mgr.spawnRoster(specFromValid());
    if (spawned._tag !== "Ok") throw new Error("spawn failed");
    // Validspec sets sessionIdleSeconds to 600 (10 min).
    const t0 = deps.clock();
    // Advance well past the idle ceiling (700s) with no peer events.
    const outcome = await mgr.stepBudget(
      ID,
      asWallClockMs(t0 + 700 * 1000),
    );
    expect(outcome._tag).toBe("MemberRetired");
    if (outcome._tag !== "MemberRetired") return;
    expect(outcome.verdict._tag).toBe("IdleTimeoutTripped");
  });

  it("recordPeerMessageObserved holds the idle clock for that session", async () => {
    const { deps } = makeDeps();
    const mgr = createRosterManager(deps);
    const spawned = await mgr.spawnRoster(specFromValid());
    if (spawned._tag !== "Ok") throw new Error("spawn failed");
    const t0 = deps.clock();
    // Reset each member's idle clock at t0 + 5 min.
    for (const m of spawned.value) {
      const r = mgr.recordPeerMessageObserved(
        ID,
        m.session,
        asWallClockMs(t0 + 300 * 1000),
      );
      expect(r._tag).toBe("Ok");
    }
    // At t0 + 11 min, every member's idle is 6 min (< 10min ceiling).
    const outcome = await mgr.stepBudget(
      ID,
      asWallClockMs(t0 + 660 * 1000),
    );
    expect(outcome._tag).toBe("WithinBudget");
  });

  it("recordTokensConsumed + stepBudget trips RetireRoster past the ceiling", async () => {
    const { deps } = makeDeps();
    const mgr = createRosterManager(deps);
    const spawned = await mgr.spawnRoster(specFromValid());
    if (spawned._tag !== "Ok") throw new Error("spawn failed");
    // Validspec sets rosterBudgetTokens to 1_000_000. Consume 1_100_000.
    const session = spawned.value[0].session;
    mgr.recordTokensConsumed(ID, session, asTokenCount(600_000));
    mgr.recordTokensConsumed(ID, session, asTokenCount(500_000));
    const outcome = await mgr.stepBudget(ID, asWallClockMs(deps.clock()));
    expect(outcome._tag).toBe("RosterRetired");
    if (outcome._tag !== "RosterRetired") return;
    expect(outcome.verdict._tag).toBe("RosterTokenBudgetTripped");
  });

  it("retireMember folds MemberRetired so later stepBudget ignores the retired session", async () => {
    const { deps } = makeDeps();
    const mgr = createRosterManager(deps);
    const spawned = await mgr.spawnRoster(specFromValid());
    if (spawned._tag !== "Ok") throw new Error("spawn failed");
    // Retire one member so it's frozen in the budget state.
    await mgr.retireMember(ID, spawned.value[0].session, { _tag: "ExplicitRetire" });
    // Advance every other member's idle clock so they stay within budget.
    const t0 = deps.clock();
    for (const m of spawned.value.slice(1)) {
      mgr.recordPeerMessageObserved(ID, m.session, asWallClockMs(t0 + 500_000));
    }
    // At t0 + 700s, the retired member's idle is 700s but it's frozen;
    // the others' idle is 200s.
    const outcome = await mgr.stepBudget(
      ID,
      asWallClockMs(t0 + 700_000),
    );
    expect(outcome._tag).toBe("WithinBudget");
  });

  it("stepBudget on an unknown roster returns StepFailed (RosterNotFound)", async () => {
    const { deps } = makeDeps();
    const mgr = createRosterManager(deps);
    const outcome = await mgr.stepBudget(
      asRosterId("never-spawned"),
      asWallClockMs(0),
    );
    expect(outcome._tag).toBe("StepFailed");
    if (outcome._tag !== "StepFailed") return;
    expect(outcome.reason._tag).toBe("RosterNotFound");
  });

  it("record* on an unknown roster returns RosterNotFound", () => {
    const { deps } = makeDeps();
    const mgr = createRosterManager(deps);
    const r1 = mgr.recordPeerMessageObserved(
      asRosterId("ghost"),
      asAoSessionName("s"),
      asWallClockMs(0),
    );
    expect(r1._tag).toBe("Err");
    const r2 = mgr.recordTokensConsumed(
      asRosterId("ghost"),
      asAoSessionName("s"),
      asTokenCount(1),
    );
    expect(r2._tag).toBe("Err");
  });
});
