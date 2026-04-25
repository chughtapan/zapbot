/**
 * test/integration/moltzap-app-roster — end-to-end integration test.
 *
 * Anchors: sbd#203 Phase 2; sbd#170 SPEC rev 2, §5 bullets on
 * `app.createSession({invitedAgentIds})` and 2-member roster round trip.
 * sbd#213: admission-flow integration tests (positive path, partial-admission
 * failure, and timeout path).
 *
 * Boots a fresh bridge against the shared test server (spawned by globalSetup),
 * registers worker agents via HTTP, calls createBridgeSession, and asserts the
 * session + conversation map are correctly populated.
 *
 * Bridge is booted once in beforeAll and torn down in afterAll — one 12–15 s
 * cold boot amortised across all 6 tests in this file.
 */

import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";
import { Effect } from "effect";
import {
  __resetBridgeAppForTests,
  bootBridgeApp,
  bridgeAgentId,
  createBridgeSession,
  shutdownBridgeApp,
} from "../../src/moltzap/bridge-app.ts";
import { ALL_CONVERSATION_KEYS } from "../../src/moltzap/conversation-keys.ts";
import type { MoltzapSenderId } from "../../src/moltzap/types.ts";
import { registerAgent } from "@moltzap/client/test";

// Injected by globalSetup (vitest provide/inject).
const HTTP_BASE = inject("moltzapHttpBaseUrl") as string;

// Any non-empty string is accepted when the server has no registration
// secret configured (MOLTZAP_DEV_MODE=true, no YAML registration.secret).
// Bridge name must be unique per server instance; server DB has UNIQUE constraint
// on agents.name. Fixed per-file name works because the server process is
// re-spawned fresh each `vitest run` invocation (in-memory PGlite).
const BRIDGE_ENV = {
  ZAPBOT_MOLTZAP_REGISTRATION_SECRET: "test-open",
  ZAPBOT_MOLTZAP_BRIDGE_AGENT_NAME: "bridge-roster",
};

describe("moltzap app-sdk integration — roster session", () => {
  beforeAll(async () => {
    __resetBridgeAppForTests();
    const result = await Effect.runPromise(
      bootBridgeApp({ serverUrl: HTTP_BASE, env: BRIDGE_ENV }).pipe(
        Effect.either,
      ),
    );
    if (result._tag === "Left") {
      throw new Error(
        `[roster] bridge boot failed: ${JSON.stringify(result.left)}`,
      );
    }
  }, 35_000);

  afterAll(async () => {
    await Effect.runPromise(shutdownBridgeApp());
    __resetBridgeAppForTests();
  });

  it("bridge constructs MoltZapApp with orchestrator manifest and starts session", () => {
    // bootBridgeApp succeeded (beforeAll did not throw); agentId must be set.
    expect(bridgeAgentId()).not.toBeNull();
  });

  it("app.createSession({invitedAgentIds}) creates a session with a non-null id", async () => {
    const w1 = await Effect.runPromise(
      registerAgent(HTTP_BASE, "roster-worker-1"),
    );
    const w2 = await Effect.runPromise(
      registerAgent(HTTP_BASE, "roster-worker-2"),
    );

    const result = await Effect.runPromise(
      createBridgeSession({
        invitedAgentIds: [
          w1.agentId as MoltzapSenderId,
          w2.agentId as MoltzapSenderId,
        ],
      }).pipe(Effect.either),
    );

    expect(result._tag).toBe("Right");
    if (result._tag !== "Right") return;
    expect(typeof result.right.sessionId).toBe("string");
    expect(result.right.sessionId.length).toBeGreaterThan(0);
  });

  it("session conversation map carries all 5 role-pair keys for the orchestrator manifest", async () => {
    const w = await Effect.runPromise(
      registerAgent(HTTP_BASE, "roster-keys-worker"),
    );

    const result = await Effect.runPromise(
      createBridgeSession({
        invitedAgentIds: [w.agentId as MoltzapSenderId],
      }).pipe(Effect.either),
    );

    expect(result._tag).toBe("Right");
    if (result._tag !== "Right") return;

    const returnedKeys = Object.keys(result.right.conversations);
    for (const expected of ALL_CONVERSATION_KEYS) {
      expect(returnedKeys).toContain(expected);
    }
    expect(returnedKeys).toHaveLength(ALL_CONVERSATION_KEYS.length);
  });

  it("createBridgeSession succeeds when second party not in invitedAgentIds (admission gated server-side at connect time)", async () => {
    // Spec clarification: apps/create does not reject agents at the RPC call
    // site. The admission check runs asynchronously server-side and only gates
    // WS-level event delivery. createBridgeSession with a 1-element invite
    // list still succeeds — a non-invited agent's exclusion is not signalled
    // here but at the agent's WS event boundary.
    const invited = await Effect.runPromise(
      registerAgent(HTTP_BASE, "roster-admitted-only"),
    );

    const result = await Effect.runPromise(
      createBridgeSession({
        invitedAgentIds: [invited.agentId as MoltzapSenderId],
      }).pipe(Effect.either),
    );

    expect(result._tag).toBe("Right");
  });

  // ── sbd#213: admission-flow tests ──────────────────────────────────────

  it(
    "partial-admission failure: invite [valid-w1, bogus-uuid] returns BridgeSessionAdmissionRejected naming the unknown ID (sbd#213 case 2)",
    async () => {
      // This test exercises the partial-admission detection path in
      // awaitSessionAdmission (bridge-app.ts). When an invited agentId is
      // not present in the server DB, admitAgentsAsync rejects it silently
      // (participantRejected is sent only to the rejected agent, not to the
      // bridge initiator). The bridge's admission-wait handler detects the
      // shortfall when sessionReady fires with admitted.size < invited.size,
      // and surfaces BridgeSessionAdmissionRejected.
      //
      // Protocol path:
      //   1. valid-w1 registered (dev mode: auto-owned, admitted immediately)
      //   2. apps/create([valid-w1, bogus-uuid]) → server forks admitAgentsAsync
      //   3. valid-w1: admitted → app/participantAdmitted sent to bridge
      //   4. bogus-uuid: not in DB → rejectAgent → app/participantRejected
      //      sent only to bogus-uuid (unknown; nobody receives it)
      //   5. not allRejected → status = "active" → app/sessionReady sent to bridge
      //   6. bridge: admitted={w1}, invited={w1,bogus} → size mismatch →
      //      BridgeSessionAdmissionRejected (agentId = bogus-uuid)
      const w1 = await Effect.runPromise(
        registerAgent(HTTP_BASE, "roster-partial-w1"),
      );
      // Use a well-formed UUID that cannot exist in the PGlite DB (all zeros
      // with a distinct last octet prevents collision with real agent rows).
      const bogusId =
        "00000000-0000-0000-0000-000000000099" as MoltzapSenderId;

      const result = await Effect.runPromise(
        createBridgeSession({
          invitedAgentIds: [w1.agentId as MoltzapSenderId, bogusId],
          admissionTimeoutMs: 10_000,
        }).pipe(Effect.either),
      );

      expect(result._tag).toBe("Left");
      if (result._tag !== "Left") return;
      const err = result.left;
      expect(err._tag).toBe("BridgeSessionAdmissionRejected");
      if (err._tag !== "BridgeSessionAdmissionRejected") return;
      // reason includes all un-admitted IDs; agentId is the first missing one.
      expect(err.reason).toContain(bogusId);
    },
    30_000,
  );

  it(
    "timeout path: invite bogus-only agentId returns BridgeSessionAdmissionTimeout (sbd#213 case 3)",
    async () => {
      // This test exercises the timeout branch of awaitSessionAdmission.
      // When ALL invited agents are unknown (not in DB), admitAgentsAsync
      // sets the session to "failed" and emits app/sessionFailed to the
      // bridge. The bridge does not handle sessionFailed, so the admission
      // wait timer fires after admissionTimeoutMs.
      //
      // Protocol path:
      //   1. apps/create([bogus-uuid]) → server forks admitAgentsAsync
      //   2. bogus-uuid: not in DB → rejectAgent → allRejected = true →
      //      status = "failed" → app/sessionFailed sent to bridge (not handled)
      //   3. bridge waits for app/sessionReady or app/participantAdmitted —
      //      neither fires → timer fires → BridgeSessionAdmissionTimeout
      const bogusId =
        "00000000-0000-0000-0000-000000000098" as MoltzapSenderId;

      const result = await Effect.runPromise(
        createBridgeSession({
          invitedAgentIds: [bogusId],
          admissionTimeoutMs: 2_000,
        }).pipe(Effect.either),
      );

      expect(result._tag).toBe("Left");
      if (result._tag !== "Left") return;
      const err = result.left;
      expect(err._tag).toBe("BridgeSessionAdmissionTimeout");
      if (err._tag !== "BridgeSessionAdmissionTimeout") return;
      expect(err.waitedMs).toBe(2_000);
    },
    // Give the test itself 10s headroom beyond the 2s admission wait.
    12_000,
  );
});
