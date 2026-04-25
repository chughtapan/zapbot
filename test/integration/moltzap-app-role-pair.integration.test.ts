/**
 * test/integration/moltzap-app-role-pair — role-pair key routing.
 *
 * Anchors: sbd#203 Phase 2; sbd#170 SPEC rev 2, §5 "architect posts via
 * app-sdk conversation, implementer consumes via MCP notification, bridge
 * routes per manifest"; Invariants 6, 7.
 *
 * Tests verify that a message sent by a connected agent on a bridge-managed
 * conversation is delivered to another agent subscribed to the same
 * conversation.
 *
 * Worker agents connect via raw MoltZapWsClient (not bootClaudeCodeChannel)
 * because the MCP stdio transport is too heavy for an integration test
 * context. The routing semantics are identical: server-side broadcast on the
 * conversation's participant list.
 *
 * Skipped (directionality is convention-only in v1, not server-enforced):
 *   - "architect sendOnKey('coord-implementer-to-architect') is rejected"
 *     Rev 4 §8.6 clarified: no server-side per-participant send filter exists.
 *     The constraint is publisher-code convention, not an RPC gate.
 *   - "reviewer cannot register onMessageForKey('coord-architect-peer')"
 *     Worker-side filtering is implemented in the channel plugin, not the
 *     server; cannot be verified in a server integration test.
 */

import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";
import { Effect, Duration } from "effect";
import {
  __resetBridgeAppForTests,
  bootBridgeApp,
  createBridgeSession,
  shutdownBridgeApp,
} from "../../src/moltzap/bridge-app.ts";
import type { MoltzapSenderId } from "../../src/moltzap/types.ts";
import { MoltZapWsClient } from "@moltzap/client";
import { registerAgent } from "@moltzap/client/test";
import { EventNames } from "@moltzap/protocol";

const HTTP_BASE = inject("moltzapHttpBaseUrl") as string;
const WS_BASE = inject("moltzapWsBaseUrl") as string;

// Fixed per-file bridge name: unique within one server instance lifetime.
const BRIDGE_ENV = {
  ZAPBOT_MOLTZAP_REGISTRATION_SECRET: "test-open",
  ZAPBOT_MOLTZAP_BRIDGE_AGENT_NAME: "bridge-rolepair",
};
/** Time to wait for participantAdmitted events after createBridgeSession. */
const ADMISSION_SETTLE_MS = 2_000;

describe("moltzap app-sdk integration — role-pair routing", () => {
  beforeAll(async () => {
    __resetBridgeAppForTests();
    const result = await Effect.runPromise(
      bootBridgeApp({ serverUrl: HTTP_BASE, env: BRIDGE_ENV }).pipe(
        Effect.either,
      ),
    );
    if (result._tag === "Left") {
      throw new Error(
        `[role-pair] bridge boot failed: ${JSON.stringify(result.left)}`,
      );
    }
  }, 35_000);

  afterAll(async () => {
    await Effect.runPromise(shutdownBridgeApp());
    __resetBridgeAppForTests();
  });

  it("implementer sendRpc(messages/send) on coord-implementer-to-architect delivers message to architect", async () => {
    // Register implementer + architect worker agents.
    const implAgent = await Effect.runPromise(
      registerAgent(HTTP_BASE, "rolepair-impl-1"),
    );
    const archAgent = await Effect.runPromise(
      registerAgent(HTTP_BASE, "rolepair-arch-1"),
    );

    // Bridge creates session; both workers get invited.
    const sessionResult = await Effect.runPromise(
      createBridgeSession({
        invitedAgentIds: [
          implAgent.agentId as MoltzapSenderId,
          archAgent.agentId as MoltzapSenderId,
        ],
      }).pipe(Effect.either),
    );
    expect(sessionResult._tag).toBe("Right");
    if (sessionResult._tag !== "Right") return;

    const { conversations } = sessionResult.right;
    const implToArchConvId = conversations["coord-implementer-to-architect"];
    expect(typeof implToArchConvId).toBe("string");

    // Connect both worker WS clients.
    const implClient = new MoltZapWsClient({
      serverUrl: WS_BASE,
      agentKey: implAgent.apiKey,
    });
    const archClient = new MoltZapWsClient({
      serverUrl: WS_BASE,
      agentKey: archAgent.apiKey,
    });

    await Effect.runPromise(
      Effect.all(
        [
          implClient.connect().pipe(
            Effect.mapError((e) => new Error(`impl connect: ${String(e)}`)),
          ),
          archClient.connect().pipe(
            Effect.mapError((e) => new Error(`arch connect: ${String(e)}`)),
          ),
        ],
        { concurrency: 2 },
      ),
    );

    try {
      // Wait for server's async admitAgentsAsync daemon to add workers to
      // conversation_participants before they try to send/receive.
      await sleep(ADMISSION_SETTLE_MS);

      // Architect starts waiting for a message event.
      const archReceive = Effect.runPromise(
        archClient
          .waitForEvent(EventNames.MessageReceived, 10_000)
          .pipe(
            Effect.mapError((e) => new Error(`arch wait failed: ${String(e)}`)),
          ),
      );

      // Implementer sends on coord-implementer-to-architect.
      await Effect.runPromise(
        implClient
          .sendRpc("messages/send", {
            conversationId: implToArchConvId,
            parts: [{ type: "text", text: "impl → arch: hello" }],
          })
          .pipe(
            Effect.mapError(
              (e) => new Error(`impl send failed: ${String(e)}`),
            ),
          ),
      );

      // Assert architect receives the message.
      const received = await archReceive;
      const msg = (received.data as { message: { parts: unknown[] } }).message;
      expect(msg.parts).toEqual([
        { type: "text", text: "impl → arch: hello" },
      ]);
    } finally {
      await Effect.runPromise(
        Effect.all([implClient.close(), archClient.close()], {
          concurrency: 2,
        }),
      );
    }
  });

  it("orchestrator sendRpc(messages/send) on coord-orch-to-worker delivers to worker", async () => {
    // Register both worker and orch-simulating agent before creating the session
    // so both are included in invitedAgentIds (required to be a conversation participant).
    const [workerAgent, orchAgent] = await Promise.all([
      Effect.runPromise(registerAgent(HTTP_BASE, "rolepair-worker-recv")),
      Effect.runPromise(registerAgent(HTTP_BASE, "rolepair-orch-sender")),
    ]);

    const sessionResult = await Effect.runPromise(
      createBridgeSession({
        invitedAgentIds: [
          workerAgent.agentId as MoltzapSenderId,
          orchAgent.agentId as MoltzapSenderId,
        ],
      }).pipe(Effect.either),
    );
    expect(sessionResult._tag).toBe("Right");
    if (sessionResult._tag !== "Right") return;

    const { conversations } = sessionResult.right;
    const orchToWorkerConvId = conversations["coord-orch-to-worker"];
    expect(typeof orchToWorkerConvId).toBe("string");

    const workerClient = new MoltZapWsClient({
      serverUrl: WS_BASE,
      agentKey: workerAgent.apiKey,
    });
    await Effect.runPromise(
      workerClient.connect().pipe(
        Effect.mapError((e) => new Error(`worker connect: ${String(e)}`)),
      ),
    );

    const orchClient = new MoltZapWsClient({
      serverUrl: WS_BASE,
      agentKey: orchAgent.apiKey,
    });
    await Effect.runPromise(
      orchClient.connect().pipe(
        Effect.mapError((e) => new Error(`orch connect: ${String(e)}`)),
      ),
    );

    try {
      await sleep(ADMISSION_SETTLE_MS);

      const workerReceive = Effect.runPromise(
        workerClient.waitForEvent(EventNames.MessageReceived, 10_000),
      );

      await Effect.runPromise(
        orchClient.sendRpc("messages/send", {
          conversationId: orchToWorkerConvId,
          parts: [{ type: "text", text: "orch → worker: dispatch" }],
        }),
      );

      const received = await workerReceive;
      const msg = (received.data as { message: { parts: unknown[] } }).message;
      expect(msg.parts).toEqual([
        { type: "text", text: "orch → worker: dispatch" },
      ]);
    } finally {
      await Effect.runPromise(
        Effect.all([workerClient.close(), orchClient.close()], {
          concurrency: 2,
        }),
      );
    }
  });

  it("architect sendRpc on coord-architect-peer delivers to another connected architect", async () => {
    const arch1 = await Effect.runPromise(
      registerAgent(HTTP_BASE, "rolepair-arch-peer-1"),
    );
    const arch2 = await Effect.runPromise(
      registerAgent(HTTP_BASE, "rolepair-arch-peer-2"),
    );

    const sessionResult = await Effect.runPromise(
      createBridgeSession({
        invitedAgentIds: [
          arch1.agentId as MoltzapSenderId,
          arch2.agentId as MoltzapSenderId,
        ],
      }).pipe(Effect.either),
    );
    expect(sessionResult._tag).toBe("Right");
    if (sessionResult._tag !== "Right") return;

    const { conversations } = sessionResult.right;
    const peerConvId = conversations["coord-architect-peer"];
    expect(typeof peerConvId).toBe("string");

    const client1 = new MoltZapWsClient({
      serverUrl: WS_BASE,
      agentKey: arch1.apiKey,
    });
    const client2 = new MoltZapWsClient({
      serverUrl: WS_BASE,
      agentKey: arch2.apiKey,
    });

    await Effect.runPromise(
      Effect.all(
        [
          client1.connect().pipe(
            Effect.mapError((e) => new Error(`arch1 connect: ${String(e)}`)),
          ),
          client2.connect().pipe(
            Effect.mapError((e) => new Error(`arch2 connect: ${String(e)}`)),
          ),
        ],
        { concurrency: 2 },
      ),
    );

    try {
      await sleep(ADMISSION_SETTLE_MS);

      const recv2 = Effect.runPromise(
        client2.waitForEvent(EventNames.MessageReceived, 10_000),
      );

      await Effect.runPromise(
        client1.sendRpc("messages/send", {
          conversationId: peerConvId,
          parts: [{ type: "text", text: "arch1 → arch2: peer review" }],
        }),
      );

      const received = await recv2;
      const msg = (received.data as { message: { parts: unknown[] } }).message;
      expect(msg.parts).toEqual([
        { type: "text", text: "arch1 → arch2: peer review" },
      ]);
    } finally {
      await Effect.runPromise(
        Effect.all([client1.close(), client2.close()], { concurrency: 2 }),
      );
    }
  });

  // ── Direction-enforcement tests (deferred — not server-enforced in v1) ────

  it.todo(
    "architect sendOnKey('coord-implementer-to-architect') is rejected at send gate (wrong direction) — not server-enforced in v1; directionality is publisher-code convention only (rev 4 §8.6)",
  );

  it.todo(
    "reviewer cannot register onMessageForKey('coord-architect-peer') — HandlerRegistrationError — worker-side channel-plugin filtering, not server-side (pending channel-plugin integration test context)",
  );

  it.todo(
    "orchestrator sendOnKey('coord-orch-to-worker') delivers to every worker — requires all workers connected simultaneously; covered by E2E smoke in moltzap-bridge-app.integration.test.ts",
  );
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
