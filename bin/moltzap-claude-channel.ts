#!/usr/bin/env bun
/**
 * moltzap-claude-channel — zapbot's worker entrypoint for the MoltZap
 * Claude channel.
 *
 * Post-sbd#200 rev 4: thin shell over `bootWorkerChannel`. No `MoltZapApp`.
 * No `identity-allowlist` gateInbound adapter (server-side
 * `participantFilter:"all"` + bridge `apps/create({invitedAgentIds})`
 * admission replace the client-side gate — see rev 4 §5.2).
 */

import { Effect } from "effect";
import {
  loadWorkerChannelEnv,
  bootWorkerChannel,
  shutdownWorkerChannel,
} from "../src/moltzap/worker-channel.ts";

const envResult = loadWorkerChannelEnv(process.env);
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

console.error(
  `[moltzap-channel] ready server=${env.serverUrl} role=${env.role}` +
    (env.bridgeAgentId !== null ? ` bridge=${env.bridgeAgentId}` : ""),
);

const keepAlive = setInterval(() => {}, 1_000);
async function shutdown(signal: string): Promise<void> {
  clearInterval(keepAlive);
  console.error(`[moltzap-channel] stopping on ${signal}`);
  await Effect.runPromise(shutdownWorkerChannel()).catch(() => undefined);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

function fatal(message: string): never {
  console.error(`[moltzap-channel] ${message}`);
  process.exit(1);
}
