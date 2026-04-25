#!/usr/bin/env bun
/**
 * moltzap-claude-channel — zapbot's worker entrypoint for the MoltZap
 * Claude channel.
 *
 * Architect rev 4 §2 worker-side glue. Heavy lifting (credential
 * resolution, AO resume metadata, debug logging) lives in
 * `src/moltzap/worker-channel.ts`.
 *
 * The transitional self-register path (sbd#205 deletion target) is
 * still reachable through `resolveWorkerCredentials`. Once sbd#205
 * lands, this bin can collapse to env decode + bootWorkerChannel +
 * signal handlers (architect rev 4 ≤50 LOC end state).
 */

import process from "node:process";
import { Effect } from "effect";
import {
  bootWorkerChannel,
  createWorkerDebugLogger,
  formatWorkerCredentialsError,
  loadWorkerChannelEnv,
  resolveWorkerCredentials,
  shutdownWorkerChannel,
  writeWorkerMetadata,
} from "../src/moltzap/worker-channel.ts";

const log = (...args: unknown[]): void => console.error("[moltzap-channel]", ...args);
const debug = createWorkerDebugLogger(process.env);
debug("boot");

const credsResult = await resolveWorkerCredentials(process.env);
if (credsResult._tag === "Err") fatal(formatWorkerCredentialsError(credsResult.error));
const creds = credsResult.value;

const envResult = loadWorkerChannelEnv({ ...process.env, MOLTZAP_AGENT_KEY: creds.agentKey });
if (envResult._tag === "Err") fatal(`env: ${envResult.error._tag}`);
const env = envResult.value;

const boot = await Effect.runPromise(
  bootWorkerChannel({
    serverUrl: env.serverUrl,
    agentKey: env.agentKey,
    role: env.role,
    logger: { info: log, warn: log, error: log },
  }).pipe(Effect.either),
);
if (boot._tag === "Left") fatal(`boot: ${boot.left._tag}`);

writeWorkerMetadata(process.env, creds, env.serverUrl);
log(
  `ready agent=${creds.senderId} server=${env.serverUrl} role=${env.role}` +
    (env.bridgeAgentId !== null ? ` bridge=${env.bridgeAgentId}` : ""),
);
debug(`ready role=${env.role}`);

const keepAlive = setInterval(() => {}, 1_000);
async function shutdown(signal: string): Promise<void> {
  clearInterval(keepAlive);
  log(`stopping on ${signal}`);
  debug(`shutdown ${signal}`);
  await Effect.runPromise(shutdownWorkerChannel()).catch(() => undefined);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

function fatal(message: string): never {
  debug(`fatal ${message}`);
  log(message);
  process.exit(1);
}
