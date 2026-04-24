#!/usr/bin/env bun
/**
 * moltzap-claude-channel — zapbot's AO session entry for the MoltZap Claude
 * channel. Post-sbd#172 this is a thin adapter over
 * `@moltzap/claude-code-channel` (spec A8: ≤ 150 LOC).
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { Effect } from "effect";
import { bootClaudeCodeChannel } from "@moltzap/claude-code-channel";
import { resolveChannelBootstrap } from "../src/moltzap/boot-env.ts";
import {
  buildSenderAllowlistGate,
  fromSenderIds,
} from "../src/moltzap/identity-allowlist.ts";
import { asMoltzapSenderId } from "../src/moltzap/types.ts";

const debugLogPath = resolveDebugLogPath(process.env);
logDebug("boot");

const bootstrap = await resolveChannelBootstrap(process.env);
if (bootstrap._tag === "Err") fatal(bootstrap.error);

const allowlistIds = parseAllowlistCsv(process.env.MOLTZAP_ALLOWED_SENDERS);
const logger = {
  info: (...args: unknown[]) => console.error("[moltzap-channel]", ...args),
  warn: (...args: unknown[]) => console.error("[moltzap-channel]", ...args),
  error: (...args: unknown[]) => console.error("[moltzap-channel]", ...args),
};

const booted = await bootClaudeCodeChannel({
  serverUrl: bootstrap.value.serverUrl,
  agentKey: bootstrap.value.apiKey,
  logger,
  ...(allowlistIds.length > 0
    ? { gateInbound: buildSenderAllowlistGate(fromSenderIds(allowlistIds)) }
    : {}),
});
if (booted._tag === "Err") fatal(`${booted.error._tag}: ${booted.error.cause}`);
const handle = booted.value;

writeMetadataKey("moltzap_sender_id", bootstrap.value.localSenderId);
writeMetadataKey("moltzap_api_key", bootstrap.value.apiKey);
writeMetadataKey("moltzap_server_url", bootstrap.value.serverUrl);

const role = process.env.AO_CALLER_TYPE === "orchestrator" ? "orchestrator" : "worker";
console.error(
  `[moltzap-channel] ready agent=${bootstrap.value.localSenderId} server=${bootstrap.value.serverUrl} role=${role}`,
);
logDebug(`ready role=${role}`);

const keepAlive = setInterval(() => {}, 1_000);
async function shutdown(signal: string): Promise<void> {
  clearInterval(keepAlive);
  console.error(`[moltzap-channel] stopping on ${signal}`);
  logDebug(`shutdown ${signal}`);
  await Effect.runPromise(handle.stop()).catch(() => undefined);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

function parseAllowlistCsv(raw: string | undefined) {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(asMoltzapSenderId);
}

function writeMetadataKey(key: string, value: string): void {
  const dataDir = trim(process.env.AO_DATA_DIR);
  const sessionId = trim(process.env.AO_SESSION);
  if (dataDir === null || sessionId === null) return;
  const path = `${dataDir}/${sessionId}`;
  let lines: string[] = [];
  try {
    lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
  } catch {
    return;
  }
  const next = `${key}=${value}`;
  let replaced = false;
  const updated = lines.map((l) =>
    l.startsWith(`${key}=`) ? ((replaced = true), next) : l,
  );
  if (!replaced) updated.push(next);
  writeFileSync(path, `${updated.join("\n")}\n`, "utf8");
}

function trim(v: string | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function resolveDebugLogPath(env: NodeJS.ProcessEnv): string {
  const explicit = trim(env.MOLTZAP_CHANNEL_DEBUG_LOG_PATH);
  if (explicit !== null) return explicit;
  const name =
    trim(env.AO_SESSION_NAME) ?? trim(env.AO_SESSION) ?? `pid-${process.pid}`;
  return join("/tmp", `moltzap-channel-${name}.log`);
}

function logDebug(message: string): void {
  try {
    mkdirSync(dirname(debugLogPath), { recursive: true });
    appendFileSync(debugLogPath, `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch {
    // best-effort
  }
}

function fatal(message: string): never {
  logDebug(`fatal ${message}`);
  console.error(`[moltzap-channel] ${message}`);
  process.exit(1);
}
