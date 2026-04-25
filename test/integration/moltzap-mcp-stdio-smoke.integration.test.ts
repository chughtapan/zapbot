/**
 * test/integration/moltzap-mcp-stdio-smoke — MCP-stdio production path smoke test.
 *
 * Anchors: sbd#222 (bootClaudeCodeChannel wrapper gap); closes verification
 * gap from sbd#221 item 4 (proven via wire-equivalent; not actual MCP-stdio path).
 *
 * Exercises the production entrypoint `bin/moltzap-claude-channel.ts` end-to-end:
 *   1. Worker spawned as child process via StdioClientTransport.
 *   2. Worker boots `bootClaudeCodeChannel` → MCP stdio hooked.
 *   3. Sender sends a real role-pair message on coord-orch-to-worker.
 *   4. Worker's MCP stdio receives `notifications/claude/channel`.
 *   5. `reply` tool delivers outbound → sender observes on the same conversation.
 */

import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_BIN = join(__dirname, "../../bin/moltzap-claude-channel.ts");

/** ms to wait after createBridgeSession for the async admission daemon. */
const ADMISSION_SETTLE_MS = 2_500;
/** ms to wait for worker's stderr "ready" line after MCP connect. */
const WORKER_READY_TIMEOUT_MS = 12_000;
/** ms to wait for the inbound notifications/claude/channel at MCP client. */
const NOTIFICATION_TIMEOUT_MS = 12_000;

const BRIDGE_ENV = {
  ZAPBOT_MOLTZAP_REGISTRATION_SECRET: "test-open",
  ZAPBOT_MOLTZAP_BRIDGE_AGENT_NAME: "bridge-stdio-smoke",
};

// ── Suite setup ──────────────────────────────────────────────────────

describe("MCP-stdio smoke: bootClaudeCodeChannel production path (sbd#222)", () => {
  beforeAll(async () => {
    __resetBridgeAppForTests();
    const result = await Effect.runPromise(
      bootBridgeApp({ serverUrl: HTTP_BASE, env: BRIDGE_ENV }).pipe(Effect.either),
    );
    if (result._tag === "Left") {
      throw new Error(`[stdio-smoke] bridge boot failed: ${JSON.stringify(result.left)}`);
    }
  }, 35_000);

  afterAll(async () => {
    await Effect.runPromise(shutdownBridgeApp());
    __resetBridgeAppForTests();
  });

  // ── Main smoke test ──────────────────────────────────────────────

  it(
    "worker spawned via bin/moltzap-claude-channel.ts: MCP receives notifications/claude/channel + reply tool delivers outbound",
    async () => {
      // ── Register agents ─────────────────────────────────────────
      const [workerReg, senderReg] = await Promise.all([
        Effect.runPromise(registerAgent(HTTP_BASE, "stdio-smoke-worker")),
        Effect.runPromise(registerAgent(HTTP_BASE, "stdio-smoke-sender")),
      ]);

      // ── Create bridge session → invites both agents ──────────────
      const sessionResult = await Effect.runPromise(
        createBridgeSession({
          invitedAgentIds: [
            workerReg.agentId as MoltzapSenderId,
            senderReg.agentId as MoltzapSenderId,
          ],
        }).pipe(Effect.either),
      );
      expect(sessionResult._tag).toBe("Right");
      if (sessionResult._tag !== "Right") return;
      const { conversations } = sessionResult.right;
      const orchToWorkerConvId = conversations["coord-orch-to-worker"];
      expect(typeof orchToWorkerConvId).toBe("string");

      // Wait for async admission daemon.
      await sleep(ADMISSION_SETTLE_MS);

      // ── Spawn worker via MCP StdioClientTransport ────────────────
      const transport = new StdioClientTransport({
        command: "bun",
        args: ["run", WORKER_BIN],
        env: buildWorkerEnv(workerReg.apiKey, workerReg.agentId),
        stderr: "pipe",
      });
      const mcpClient = new Client({ name: "smoke-mcp-client", version: "1.0.0" });

      // Notification capture (set before connect so no delivery is missed).
      let capturedNotification: { method: string; params: Record<string, unknown> } | null = null;
      const notificationArrived = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Timeout: notifications/claude/channel not received")),
          NOTIFICATION_TIMEOUT_MS,
        );
        mcpClient.fallbackNotificationHandler = async (n) => {
          if (n.method === "notifications/claude/channel") {
            capturedNotification = n as typeof capturedNotification;
            clearTimeout(timer);
            resolve();
          }
        };
      });

      // Stderr "ready" detection (set before connect per StdioClientTransport docs).
      const stderrLines: string[] = [];
      const workerReady = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timeout: worker "ready" not seen in stderr. Collected:\n${stderrLines.join("")}`)),
          WORKER_READY_TIMEOUT_MS,
        );
        transport.stderr?.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          stderrLines.push(text);
          if (text.includes("ready")) {
            clearTimeout(timer);
            resolve();
          }
        });
      });

      try {
        // ── MCP initialize handshake ─────────────────────────────
        await mcpClient.connect(transport);
        await workerReady; // Worker is MoltZap-connected once "ready" fires.

        // ── Sender connects + sends on coord-orch-to-worker ──────
        const senderClient = new MoltZapWsClient({ serverUrl: WS_BASE, agentKey: senderReg.apiKey });
        await Effect.runPromise(
          senderClient.connect().pipe(
            Effect.mapError((e) => new Error(`sender connect: ${String(e)}`)),
          ),
        );

        try {
          await Effect.runPromise(
            senderClient
              .sendRpc("messages/send", {
                conversationId: orchToWorkerConvId,
                parts: [{ type: "text", text: "smoke: orch → worker dispatch" }],
              })
              .pipe(Effect.mapError((e) => new Error(`sender send: ${String(e)}`))),
          );

          // ── Assert MCP notification ──────────────────────────────
          await notificationArrived;
          expect(capturedNotification).not.toBeNull();
          const notif = capturedNotification!;
          expect(notif.method).toBe("notifications/claude/channel");
          const params = notif.params as {
            content: string;
            meta: { chat_id: string; message_id: string; user: string; ts: string };
          };
          expect(params.content).toBe("smoke: orch → worker dispatch");
          expect(typeof params.meta.chat_id).toBe("string");
          expect(typeof params.meta.message_id).toBe("string");
          expect(params.meta.chat_id).toBe(orchToWorkerConvId);

          // ── Call reply tool → assert outbound arrives ────────────
          // Drain any buffered events before waiting for reply.
          senderClient.drainEvents();
          const replyArrived = Effect.runPromise(
            senderClient.waitForEvent(EventNames.MessageReceived, 10_000),
          );

          const replyResult = await mcpClient.callTool({
            name: "reply",
            arguments: { text: "smoke: worker → orch ack" },
          });
          expect(replyResult.isError).toBeFalsy();

          const replyEvent = await replyArrived;
          const msg = (
            replyEvent.data as { message: { senderId: string; parts: { type: string; text: string }[] } }
          ).message;
          expect(msg.senderId).toBe(workerReg.agentId);
          expect(msg.parts).toEqual([{ type: "text", text: "smoke: worker → orch ack" }]);
        } finally {
          await Effect.runPromise(senderClient.close());
        }
      } finally {
        await mcpClient.close();
      }
    },
    65_000,
  );
});

// ── Helpers ──────────────────────────────────────────────────────────

/** Build spawn env for the worker process. Inherits current env + injects MoltZap creds. */
function buildWorkerEnv(apiKey: string, agentId: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.MOLTZAP_AGENT_KEY = apiKey;
  env.MOLTZAP_LOCAL_SENDER_ID = agentId;
  env.MOLTZAP_SERVER_URL = HTTP_BASE;
  env.AO_CALLER_TYPE = "implementer";
  return env;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
