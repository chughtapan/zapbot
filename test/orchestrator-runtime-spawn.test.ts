/**
 * Tests for sbd#201 — orchestrator spawn path wiring (revision pass after
 * stamina round-1 ESCALATED, codex P1 #1/#2/#3).
 *
 * Anchors:
 *   - sbd#201 acceptance — `createBridgeSession` called from the production
 *     spawn path.
 *   - Architect rev 4 §4.3 — ONE bridge session per roster, invited list =
 *     union of all worker senderIds; admission completes BEFORE workers are
 *     spawned.
 *   - Codex stamina round-1:
 *       * P1 #1: per-spawn was structurally wrong; per-roster is canonical.
 *       * P1 #2: `apps/create` admission is async; spawn must wait.
 *       * P1 #3: retire-close ordering — close first, delete-from-map on
 *         success.
 *
 * Strategy: drive the deps directly. `prepareRosterSession` runs the
 * registration loop and the single `createBridgeSession` against a mocked
 * `fetch` + an un-booted bridge singleton, so we can prove ordering and
 * shape without standing up a live MoltZap server.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAoCliRosterManagerDeps } from "../src/orchestrator/runtime.ts";
import { __resetBridgeAppForTests } from "../src/moltzap/bridge-app.ts";
import { asMoltzapSenderId } from "../src/moltzap/types.ts";
import {
  asAoSessionName,
  asIssueNumber,
  asProjectName,
} from "../src/types.ts";
import { asRosterId } from "../src/orchestrator/roster.ts";

beforeEach(() => {
  __resetBridgeAppForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetBridgeAppForTests();
});

const ROSTER_ID = asRosterId("roster-1");
const ISSUE = asIssueNumber(1);
const PROJECT = asProjectName("zapbot");

describe("createAoCliRosterManagerDeps — per-roster prepare phase (architect rev 4 §4.3)", () => {
  it("registers all workers BEFORE invoking createBridgeSession (one HTTP register per worker)", async () => {
    // Three members → expect three /api/v1/auth/register POSTs.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input) =>
        new Response(
          JSON.stringify({
            apiKey: `key-${String(input).slice(-8)}`,
            agentId: `worker-${Math.random().toString(16).slice(2, 8)}`,
          }),
          {
            status: 201,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );

    const deps = createAoCliRosterManagerDeps(
      {
        configPath: null,
        env: {},
        timeoutMs: 5_000,
      },
      {
        orchestratorSenderId: asMoltzapSenderId("orch-1"),
        moltzapAuth: {
          serverUrl: "wss://moltzap.example/ws",
          registrationSecret: "reg-secret",
        },
      },
    );

    const result = await deps.prepareRosterSession({
      rosterId: ROSTER_ID,
      members: [
        { role: "architect", displayLabel: "architect-a" },
        { role: "implementer", displayLabel: "implementer-1" },
        { role: "reviewer", displayLabel: "reviewer-1" },
      ],
      issue: ISSUE,
      projectName: PROJECT,
    });

    // Bridge un-booted ⇒ createBridgeSession surfaces BridgeAppNotBooted
    // AFTER all three registrations completed. That's the proof the loop
    // ordering is "register × N then createBridgeSession".
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("RosterSessionPrepareFailed");
    expect(result.error.cause).toContain("bridge session");
    expect(result.error.cause).toContain("BridgeAppNotBooted");

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    for (const call of fetchSpy.mock.calls) {
      expect(String(call[0])).toContain("/api/v1/auth/register");
    }
  });

  it("propagates registration HTTP status + body in the prepare error cause (codex P3)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("invalid invite code", { status: 403 }),
    );

    const deps = createAoCliRosterManagerDeps(
      {
        configPath: null,
        env: {},
        timeoutMs: 5_000,
      },
      {
        orchestratorSenderId: asMoltzapSenderId("orch-1"),
        moltzapAuth: {
          serverUrl: "wss://moltzap.example/ws",
          registrationSecret: "reg-secret",
        },
      },
    );

    const result = await deps.prepareRosterSession({
      rosterId: ROSTER_ID,
      members: [{ role: "architect", displayLabel: "architect-a" }],
      issue: ISSUE,
      projectName: PROJECT,
    });

    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error.cause).toContain("status=403");
    expect(result.error.cause).toContain("invalid invite code");
  });

  it("rejects a duplicate prepareRosterSession call for the same rosterId", async () => {
    const deps = createAoCliRosterManagerDeps(
      {
        configPath: null,
        env: {},
        timeoutMs: 5_000,
      },
      {
        orchestratorSenderId: asMoltzapSenderId("orch-1"),
        moltzapAuth: null,
      },
    );

    const first = await deps.prepareRosterSession({
      rosterId: ROSTER_ID,
      members: [{ role: "architect", displayLabel: "architect-a" }],
      issue: ISSUE,
      projectName: PROJECT,
    });
    expect(first._tag).toBe("Ok");

    const second = await deps.prepareRosterSession({
      rosterId: ROSTER_ID,
      members: [{ role: "architect", displayLabel: "architect-a" }],
      issue: ISSUE,
      projectName: PROJECT,
    });
    expect(second._tag).toBe("Err");
    if (second._tag !== "Err") return;
    expect(second.error._tag).toBe("RosterSessionPrepareFailed");
    expect(second.error.cause).toContain("already prepared");
  });
});

describe("createAoCliRosterManagerDeps — spawnSession requires a prepared roster context", () => {
  it("returns RosterContextMissing when spawnSession fires without prepare", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const deps = createAoCliRosterManagerDeps(
      {
        configPath: null,
        env: { PATH: "/nonexistent" },
        timeoutMs: 1_000,
      },
      {
        orchestratorSenderId: asMoltzapSenderId("orch-1"),
        moltzapAuth: null,
      },
    );

    const result = await deps.spawnSession({
      rosterId: asRosterId("roster-never-prepared"),
      member: { role: "architect", displayLabel: "architect-a" },
      issue: ISSUE,
      projectName: PROJECT,
    });
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("MemberSpawnFailed");
    if (result.error._tag !== "MemberSpawnFailed") return;
    expect(result.error.cause).toContain("roster session not prepared");
    // No registration / spawn call should have fired — context-missing is
    // the first gate after the reserved-key check.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects reserved 'moltzap' displayLabel BEFORE consulting the prepared context", async () => {
    const deps = createAoCliRosterManagerDeps(
      {
        configPath: null,
        env: {},
        timeoutMs: 5_000,
      },
      {
        orchestratorSenderId: asMoltzapSenderId("orch-1"),
        moltzapAuth: null,
      },
    );

    const result = await deps.spawnSession({
      rosterId: asRosterId("roster-never-prepared"),
      member: { role: "architect", displayLabel: "moltzap" },
      issue: ISSUE,
      projectName: PROJECT,
    });

    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("ReservedMcpKeyCollision");
  });
});

describe("createAoCliRosterManagerDeps — bridge session lifecycle", () => {
  it("retireSession of an unknown session does not call closeBridgeSession (only ao kill)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const deps = createAoCliRosterManagerDeps(
      {
        configPath: null,
        env: { PATH: "/nonexistent" },
        timeoutMs: 1_000,
      },
      {
        orchestratorSenderId: asMoltzapSenderId("orch-1"),
        moltzapAuth: null,
      },
    );

    // Session was never spawned through this dep, so the rosterIdBySession
    // map has no entry. retireSession should run only `ao kill` (which
    // fails because PATH is bogus) and never touch the bridge.
    const result = await deps.retireSession(asAoSessionName("ghost"));
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("RetireReleaseFailed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("releaseRosterSession is a no-op for an unknown rosterId", async () => {
    const deps = createAoCliRosterManagerDeps(
      {
        configPath: null,
        env: {},
        timeoutMs: 5_000,
      },
      {
        orchestratorSenderId: asMoltzapSenderId("orch-1"),
        moltzapAuth: null,
      },
    );

    // No throw, no error channel — best-effort cleanup is the contract.
    await expect(
      deps.releaseRosterSession(asRosterId("never-prepared")),
    ).resolves.toBeUndefined();
  });
});

describe("createAoCliRosterManagerDeps — moltzapAuth: null short-circuits credential minting", () => {
  it("prepareRosterSession with moltzapAuth=null does not call fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const deps = createAoCliRosterManagerDeps(
      {
        configPath: null,
        env: {},
        timeoutMs: 5_000,
      },
      {
        orchestratorSenderId: asMoltzapSenderId("orch-1"),
        moltzapAuth: null,
      },
    );

    const result = await deps.prepareRosterSession({
      rosterId: ROSTER_ID,
      members: [{ role: "architect", displayLabel: "architect-a" }],
      issue: ISSUE,
      projectName: PROJECT,
    });
    expect(result._tag).toBe("Ok");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("spawnSession after a moltzapAuth=null prepare runs without registration", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const deps = createAoCliRosterManagerDeps(
      {
        configPath: null,
        env: { PATH: "/nonexistent" },
        timeoutMs: 1_000,
      },
      {
        orchestratorSenderId: asMoltzapSenderId("orch-1"),
        moltzapAuth: null,
      },
    );

    const prepared = await deps.prepareRosterSession({
      rosterId: ROSTER_ID,
      members: [{ role: "architect", displayLabel: "architect-a" }],
      issue: ISSUE,
      projectName: PROJECT,
    });
    if (prepared._tag !== "Ok") throw new Error("prepare failed");

    // Spawn shells out to bun (PATH bogus), surfaces SpawnProcessFailed.
    // No fetch (no registration) should have fired.
    const result = await deps.spawnSession({
      rosterId: ROSTER_ID,
      member: { role: "architect", displayLabel: "architect-a" },
      issue: ISSUE,
      projectName: PROJECT,
    });
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("MemberSpawnFailed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
