/**
 * Tests for sbd#201 — orchestrator spawn path wiring.
 *
 * Anchors: sbd#201 acceptance — `createBridgeSession` called from the
 * production spawn path. The roster manager's `spawnSession` dep mints
 * worker creds via `registerBridgeAgent` (HTTP POST) and admits them to
 * bridge-owned conversations via `createBridgeSession({invitedAgentIds:
 * [thisWorkerSenderId]})` BEFORE `bun run bin/ao-spawn-with-moltzap.ts`
 * fires (architect rev 4 §4.3).
 *
 * Strategy: short-circuit the spawn at the registration step by failing
 * the mocked `fetch` with HTTP 403. The dep must surface
 * `MemberSpawnFailed` with a cause that names the registration failure
 * — proof that registration runs first. With registration mocked to
 * succeed but the bridge un-booted, `createBridgeSession` surfaces
 * `BridgeAppNotBooted` — proof that bridge admission is the next step.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAoCliRosterManagerDeps,
} from "../src/orchestrator/runtime.ts";
import { __resetBridgeAppForTests } from "../src/moltzap/bridge-app.ts";
import { asMoltzapSenderId } from "../src/moltzap/types.ts";
import {
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

describe("createAoCliRosterManagerDeps — spawn-time createBridgeSession wiring (sbd#201)", () => {
  it("calls registerBridgeAgent before spawn; surfaces registration HTTP failure as MemberSpawnFailed", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("forbidden", { status: 403 }),
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

    const result = await deps.spawnSession({
      rosterId: asRosterId("roster-1"),
      member: { role: "architect", displayLabel: "architect-a" },
      issue: asIssueNumber(1),
      projectName: asProjectName("zapbot"),
    });

    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("MemberSpawnFailed");
    if (result.error._tag !== "MemberSpawnFailed") return;
    expect(result.error.cause).toContain("registration");

    // Exactly one fetch was issued — the registration call. No spawn ran;
    // bun was never invoked, so the registration step ran first.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("/api/v1/auth/register");
  });

  it("calls createBridgeSession after registration; surfaces BridgeAppNotBooted when bridge is un-booted", async () => {
    // Registration succeeds (HTTP 201 with apiKey + agentId).
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ apiKey: "key-123", agentId: "worker-a" }),
        {
          status: 201,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    // Bridge singleton is reset (beforeEach), so createBridgeSession will
    // fail with BridgeAppNotBooted. This proves createBridgeSession runs
    // immediately after registration, before spawn.
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

    const result = await deps.spawnSession({
      rosterId: asRosterId("roster-1"),
      member: { role: "implementer", displayLabel: "implementer-1" },
      issue: asIssueNumber(1),
      projectName: asProjectName("zapbot"),
    });

    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("MemberSpawnFailed");
    if (result.error._tag !== "MemberSpawnFailed") return;
    expect(result.error.cause).toContain("bridge session");
    expect(result.error.cause).toContain("BridgeAppNotBooted");
  });

  it("rejects reserved 'moltzap' displayLabel BEFORE registration runs", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("forbidden", { status: 403 }),
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

    const result = await deps.spawnSession({
      rosterId: asRosterId("roster-1"),
      member: { role: "architect", displayLabel: "moltzap" },
      issue: asIssueNumber(1),
      projectName: asProjectName("zapbot"),
    });

    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("ReservedMcpKeyCollision");
    // Registration must NOT have fired — reserved-key check is the first
    // gate.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("createAoCliRosterManagerDeps — moltzapAuth: null short-circuits credential minting", () => {
  it("skips registerBridgeAgent + createBridgeSession when moltzapAuth is null", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("forbidden", { status: 403 }),
    );

    // No moltzapAuth: the dep should NOT call fetch (no registration).
    // The spawn shells out to bun, which will fail (no fake bin set up),
    // surfacing MemberSpawnFailed with a spawn-error cause — but
    // crucially, NOT a registration error.
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
      rosterId: asRosterId("roster-1"),
      member: { role: "architect", displayLabel: "architect-a" },
      issue: asIssueNumber(1),
      projectName: asProjectName("zapbot"),
    });

    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("MemberSpawnFailed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
