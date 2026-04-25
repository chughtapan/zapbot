/**
 * test/integration/moltzap-app-roster — end-to-end integration test.
 *
 * Anchors: sbd#203 Phase 2; sbd#170 SPEC rev 2, §5 bullets on
 * `app.createSession({invitedAgentIds})` and 2-member roster round trip.
 *
 * Boots a fresh bridge against the shared test server (spawned by globalSetup),
 * registers worker agents via HTTP, calls createBridgeSession, and asserts the
 * session + conversation map are correctly populated.
 *
 * Bridge is booted once in beforeAll and torn down in afterAll — one 12–15 s
 * cold boot amortised across all 4 tests in this file.
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
});
