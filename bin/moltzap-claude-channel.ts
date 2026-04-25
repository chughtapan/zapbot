#!/usr/bin/env bun
/**
 * moltzap-claude-channel — zapbot's worker entrypoint for the MoltZap
 * Claude channel.
 *
 * Post-sbd#200 rev 4: thin shell over `bootWorkerChannel`. No `MoltZapApp`.
 * No `identity-allowlist` gateInbound adapter (server-side
 * `participantFilter:"all"` + bridge `apps/create({invitedAgentIds})`
 * admission replace the client-side gate — see rev 4 §5.2).
 *
 * Two boot paths, chosen by which credentials the spawn env carries:
 *   1. `MOLTZAP_AGENT_KEY` (or legacy `MOLTZAP_API_KEY`) set — use it
 *      directly. This is the path the architect plan anticipates once
 *      `mintWorkerCreds` lands in the bridge's per-spawn roster code.
 *   2. `MOLTZAP_REGISTRATION_SECRET` set — the transitional path used
 *      today. The worker self-registers via
 *      `POST /api/v1/auth/register` using the invite-code secret, then
 *      proceeds as if path 1 had provided the key. Required until the
 *      bridge takes over credential minting (roster refactor, follow-up).
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { Effect } from "effect";
import {
  loadWorkerChannelEnv,
  bootWorkerChannel,
  shutdownWorkerChannel,
} from "../src/moltzap/worker-channel.ts";
import { registerBridgeAgent } from "../src/moltzap/bridge-identity.ts";

const debugLogPath = resolveDebugLogPath(process.env);
logDebug("boot");

const resolvedCreds = await resolveCredentials(process.env);
if (resolvedCreds._tag === "Err") fatal(resolvedCreds.error);
const creds = resolvedCreds.value;

// Re-inject the resolved agent key so loadWorkerChannelEnv resolves it.
const envForDecode: Record<string, string | undefined> = {
  ...process.env,
  MOLTZAP_AGENT_KEY: creds.agentKey,
};

const envResult = loadWorkerChannelEnv(envForDecode);
if (envResult._tag === "Err") fatal(`env: ${envResult.error._tag}`);
const env = envResult.value;

const logger = {
  info: (...args: unknown[]) => console.error("[moltzap-channel]", ...args),
  warn: (...args: unknown[]) => console.error("[moltzap-channel]", ...args),
  error: (...args: unknown[]) => console.error("[moltzap-channel]", ...args),
};

const boot = await Effect.runPromise(
  bootWorkerChannel({
    serverUrl: env.serverUrl,
    agentKey: env.agentKey,
    logger,
    role: env.role,
  }).pipe(Effect.either),
);
if (boot._tag === "Left") fatal(`boot: ${boot.left._tag}`);

// ao-spawn-with-moltzap.ts resume path (bin/ao-spawn-with-moltzap.ts:163)
// reads `moltzap_sender_id` + `moltzap_api_key` from AO session metadata.
// Preserve that contract so rosters can resume after channel restart.
writeMetadataKey("moltzap_sender_id", creds.senderId);
writeMetadataKey("moltzap_api_key", creds.agentKey);
writeMetadataKey("moltzap_server_url", env.serverUrl);

console.error(
  `[moltzap-channel] ready agent=${creds.senderId} server=${env.serverUrl} role=${env.role}` +
    (env.bridgeAgentId !== null ? ` bridge=${env.bridgeAgentId}` : ""),
);
logDebug(`ready role=${env.role}`);

const keepAlive = setInterval(() => {}, 1_000);
async function shutdown(signal: string): Promise<void> {
  clearInterval(keepAlive);
  console.error(`[moltzap-channel] stopping on ${signal}`);
  logDebug(`shutdown ${signal}`);
  await Effect.runPromise(shutdownWorkerChannel()).catch(() => undefined);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

interface ResolvedCredentials {
  readonly agentKey: string;
  readonly senderId: string;
}

async function resolveCredentials(
  env: NodeJS.ProcessEnv,
): Promise<{ _tag: "Ok"; value: ResolvedCredentials } | { _tag: "Err"; error: string }> {
  const preMinted = trim(env.MOLTZAP_AGENT_KEY) ?? trim(env.MOLTZAP_API_KEY);
  const preMintedSenderId = trim(env.MOLTZAP_LOCAL_SENDER_ID);
  if (preMinted !== null && preMintedSenderId !== null) {
    return { _tag: "Ok", value: { agentKey: preMinted, senderId: preMintedSenderId } };
  }

  const serverUrl = trim(env.MOLTZAP_SERVER_URL);
  const registrationSecret = trim(env.MOLTZAP_REGISTRATION_SECRET);
  if (serverUrl === null) return { _tag: "Err", error: "MOLTZAP_SERVER_URL is required" };
  if (registrationSecret === null) {
    return {
      _tag: "Err",
      error:
        "either MOLTZAP_AGENT_KEY (+ MOLTZAP_LOCAL_SENDER_ID) or MOLTZAP_REGISTRATION_SECRET is required",
    };
  }

  const name =
    trim(env.AO_SESSION_NAME) ?? trim(env.AO_SESSION) ?? `zb-${Date.now().toString(36)}`;
  const registration = await registerBridgeAgent({
    serverUrl,
    registrationSecret,
    displayName: name,
  });
  if (registration._tag === "Err") {
    return {
      _tag: "Err",
      error: `self-register: ${registration.error._tag}`,
    };
  }
  return {
    _tag: "Ok",
    value: {
      agentKey: registration.value.agentKey,
      senderId: registration.value.agentId as string,
    },
  };
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
