#!/usr/bin/env bun

/**
 * bin/moltzap-claude-channel — worker/orchestrator MCP channel for Claude.
 *
 * Anchors: sbd#170 SPEC rev 2 §5; architect DESIGN (issue#170, comment
 * 4311770151) §2 "bin/moltzap-claude-channel.ts" row. Boots a single
 * `MoltZapApp` via `@moltzap/app-sdk`, wires role-scoped `app.onMessage`
 * handlers through `mcp-adapter`, and exposes the MCP reply tool.
 *
 * Spec §5 ties:
 *   - imports `MoltZapApp` (not `MoltZapService` / `MoltZapWsClient`).
 *   - bridge holds the orchestrator manifest; worker holds a role-specific
 *     manifest.
 *   - OQ #6: every boot caller declares a full 4-value `SessionRole`.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { Effect } from "effect";
import {
  bootApp,
  onMessageForKey,
  onSessionReady,
  resolveKeyToConversationId,
  sendOnKey,
  shutdownApp,
} from "../src/moltzap/app-client.ts";
import {
  makeMcpForwardHandler,
  wireMcpAdapter,
  type McpAdapterContext,
} from "../src/moltzap/mcp-adapter.ts";
import {
  receivableKeysForRole,
  sendableKeysForRole,
} from "../src/moltzap/conversation-keys.ts";
import {
  decodeSessionRole,
  isWorkerRole,
  type SessionRole,
} from "../src/moltzap/session-role.ts";
import {
  asMoltzapConversationId,
  asMoltzapSenderId,
  type MoltzapSenderId,
} from "../src/moltzap/types.ts";
import { bootClaudeChannelServer } from "../src/claude-channel/server.ts";
import { err, ok } from "../src/types.ts";

const debugLogPath = resolveDebugLogPath(process.env);
logDebug("boot");

process.on("beforeExit", (code) => {
  logDebug(`beforeExit code=${code}`);
});
process.on("exit", (code) => {
  logDebug(`exit code=${code}`);
});
process.on("uncaughtException", (cause) => {
  logDebug(`uncaughtException ${stringifyCause(cause)}`);
});
process.on("unhandledRejection", (cause) => {
  logDebug(`unhandledRejection ${stringifyCause(cause)}`);
});

const role = resolveRole(process.env);
const serverUrl = requireEnv("MOLTZAP_SERVER_URL");
const agentKey = requireEnv("MOLTZAP_API_KEY");
const localSenderId = asMoltzapSenderId(
  requireEnv("MOLTZAP_LOCAL_SENDER_ID"),
);
const orchestratorSenderRaw = trimEnv(
  process.env.MOLTZAP_ORCHESTRATOR_SENDER_ID,
);
if (isWorkerRole(role) && orchestratorSenderRaw === null) {
  fatal("MOLTZAP_ORCHESTRATOR_SENDER_ID is required for worker sessions");
}
const orchestratorSenderId: MoltzapSenderId | null =
  orchestratorSenderRaw === null
    ? null
    : asMoltzapSenderId(orchestratorSenderRaw);

// Boot MCP channel server BEFORE app.start() so the reply tool surface is
// live by the time inbound messages start arriving.
const channelBoot = await bootClaudeChannelServer(
  {
    serverName: "moltzap",
    instructions: buildInstructions(role, orchestratorSenderId),
    enableReplyTool: true,
    enableDirectMessageTool: false,
    enablePermissionRelay: false,
  },
  {
    sendReply: async ({ conversationId, text }) => {
      const handle = latestHandle;
      if (handle === null) {
        return err({
          _tag: "ReplyFailed",
          cause: "MoltZap app is not booted",
        });
      }
      try {
        await Effect.runPromise(
          handle.__unsafeInner.sendTo(conversationId as unknown as string, [
            { type: "text", text },
          ]),
        );
        return ok(undefined);
      } catch (cause) {
        return err({
          _tag: "ReplyFailed",
          cause: stringifyCause(cause),
        });
      }
    },
  },
);
if (channelBoot._tag === "Err") {
  fatal(channelBoot.error.cause);
}
const channel = channelBoot.value;

writeMetadataKey("moltzap_sender_id", localSenderId as string);
writeMetadataKey("moltzap_api_key", agentKey);
writeMetadataKey("moltzap_server_url", serverUrl);

import type { ZapbotMoltZapAppHandle } from "../src/moltzap/app-client.ts";
let latestHandle: ZapbotMoltZapAppHandle | null = null;

async function bootAppAsync(): Promise<ZapbotMoltZapAppHandle> {
  return Effect.runPromise(
    bootApp({
      serverUrl,
      agentKey,
      role,
      env: process.env,
    }).pipe(
      Effect.mapError((e) => new Error(`bootApp failed: ${e._tag}`)),
    ),
  );
}

try {
  latestHandle = await bootAppAsync();

  const ctx: McpAdapterContext = {
    channel,
    localSenderId,
    orchestratorSenderId,
  };

  const receivable = [...receivableKeysForRole(role)];
  const wired = wireMcpAdapter(ctx, receivable);
  for (const key of wired) {
    const reg = onMessageForKey(
      latestHandle,
      key,
      makeMcpForwardHandler(key, ctx),
    );
    if (reg !== null) {
      // Registration is best-effort — log and continue so a
      // HandlerAlreadyRegistered on re-wire does not crash the session.
      console.error(
        `[moltzap-channel] onMessage(${key}) registration returned ${reg._tag}`,
      );
    }
  }

  onSessionReady(latestHandle, (session) => {
    logDebug(`sessionReady id=${session.id} status=${session.status}`);
  });

  console.error(
    `[moltzap-channel] ready agent=${localSenderId as string} server=${serverUrl} role=${role} sendable=${[
      ...sendableKeysForRole(role),
    ].join(",")} receivable=${receivable.join(",")}`,
  );

  async function shutdown(signal: string): Promise<void> {
    console.error(`[moltzap-channel] stopping on ${signal}`);
    logDebug(`shutdown ${signal}`);
    try {
      await Effect.runPromise(shutdownApp());
    } catch (cause) {
      logDebug(`shutdownApp err ${stringifyCause(cause)}`);
    }
    await channel.stop().catch(() => undefined);
    process.exit(0);
  }

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  // Hold the event loop until signals arrive.
  setInterval(() => {}, 1_000);
} catch (cause) {
  await channel.stop().catch(() => undefined);
  fatal(stringifyCause(cause));
}

// ── helpers ────────────────────────────────────────────────────────

function resolveRole(env: Record<string, string | undefined>): SessionRole {
  const rawRole = trimEnv(env.ZAPBOT_SESSION_ROLE) ?? trimEnv(env.AO_ROLE);
  if (rawRole !== null) {
    const decoded = decodeSessionRole(rawRole);
    if (decoded._tag === "Ok") {
      return decoded.value;
    }
    fatal(`unknown ZAPBOT_SESSION_ROLE/AO_ROLE: ${rawRole}`);
  }
  // Fallback legacy decoder (OQ #6 migration path): `AO_CALLER_TYPE`
  // carried the binary orchestrator/worker split. In the 4-value world,
  // a bare "worker" is ambiguous — default to "implementer" with a
  // loud stderr note so operators migrate.
  const caller = trimEnv(env.AO_CALLER_TYPE);
  if (caller === "orchestrator") return "orchestrator";
  if (caller === "worker") {
    console.error(
      `[moltzap-channel] AO_CALLER_TYPE=worker is ambiguous under 4-value SessionRole; defaulting to "implementer". Set ZAPBOT_SESSION_ROLE to choose explicitly.`,
    );
    return "implementer";
  }
  fatal(
    "session role unresolvable: set ZAPBOT_SESSION_ROLE (orchestrator|architect|implementer|reviewer)",
  );
}

function buildInstructions(
  role: SessionRole,
  orchestrator: MoltzapSenderId | null,
): string {
  const sendable = [...sendableKeysForRole(role)].join(", ");
  const receivable = [...receivableKeysForRole(role)].join(", ");
  return [
    `This session is connected to MoltZap as a ${role}.`,
    "Messages from other agents arrive over this Claude channel.",
    "Use the reply tool to answer the current MoltZap conversation.",
    `Sendable conversation keys: ${sendable || "(none)"}.`,
    `Receivable conversation keys: ${receivable || "(none)"}.`,
    orchestrator !== null
      ? `The orchestrator sender ID is ${orchestrator as string}.`
      : "This process IS the orchestrator.",
  ].join("\n\n");
}

function requireEnv(name: string): string {
  const value = trimEnv(process.env[name]);
  if (value === null) {
    fatal(`${name} is required`);
  }
  return value;
}

function trimEnv(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function writeMetadataKey(key: string, value: string): void {
  const dataDir = trimEnv(process.env.AO_DATA_DIR);
  const sessionId = trimEnv(process.env.AO_SESSION);
  if (dataDir === null || sessionId === null) return;
  const path = `${dataDir}/${sessionId}`;
  let lines: string[] = [];
  try {
    lines = readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0);
  } catch {
    return;
  }
  const nextLine = `${key}=${value}`;
  const updated: string[] = [];
  let replaced = false;
  for (const line of lines) {
    if (line.startsWith(`${key}=`)) {
      updated.push(nextLine);
      replaced = true;
    } else {
      updated.push(line);
    }
  }
  if (!replaced) updated.push(nextLine);
  writeFileSync(path, `${updated.join("\n")}\n`, "utf8");
}

function stringifyCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function fatal(message: string): never {
  logDebug(`fatal ${message}`);
  console.error(`[moltzap-channel] ${message}`);
  process.exit(1);
}

function resolveDebugLogPath(
  env: Record<string, string | undefined>,
): string {
  const explicit = trimEnv(env.MOLTZAP_CHANNEL_DEBUG_LOG_PATH);
  if (explicit !== null) return explicit;
  const sessionName =
    trimEnv(env.AO_SESSION_NAME) ??
    trimEnv(env.AO_SESSION) ??
    `pid-${process.pid}`;
  return join("/tmp", `moltzap-channel-${sessionName}.log`);
}

function logDebug(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    mkdirSync(dirname(debugLogPath), { recursive: true });
    appendFileSync(debugLogPath, line, "utf8");
  } catch {
    // best-effort only
  }
}

// Silence unused-export lints for helpers kept for potential future use.
void resolveKeyToConversationId;
void sendOnKey;
void asMoltzapConversationId;
