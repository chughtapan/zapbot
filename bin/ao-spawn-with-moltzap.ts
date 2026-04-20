#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import process from "node:process";

const issue = process.argv[2];
if (typeof issue !== "string" || issue.trim().length === 0) {
  fatal("usage: bun run bin/ao-spawn-with-moltzap.ts <issue-number>");
}

const orchestratorSenderId = resolveOrchestratorSenderId();
const serverUrl = trimEnv(process.env.MOLTZAP_SERVER_URL);
const registrationSecret = trimEnv(process.env.MOLTZAP_REGISTRATION_SECRET);
if (serverUrl === null) {
  fatal("MOLTZAP_SERVER_URL is required");
}
if (registrationSecret === null) {
  fatal(
    "MOLTZAP_REGISTRATION_SECRET is required to spawn workers with unique MoltZap identities",
  );
}

const childEnv: Record<string, string> = {
  ...process.env,
  AO_CONFIG_PATH: trimEnv(process.env.AO_CONFIG_PATH) ?? "",
  AO_PROJECT_ID: trimEnv(process.env.AO_PROJECT_ID) ?? "",
  MOLTZAP_SERVER_URL: serverUrl,
  MOLTZAP_REGISTRATION_SECRET: registrationSecret,
  MOLTZAP_ORCHESTRATOR_SENDER_ID: orchestratorSenderId,
};

const allowedSenders = trimEnv(process.env.MOLTZAP_ALLOWED_SENDERS);
if (allowedSenders !== null) {
  childEnv.MOLTZAP_ALLOWED_SENDERS = allowedSenders;
}

const child = spawn("ao", ["spawn", issue], {
  env: childEnv,
  stdio: "inherit",
});

child.once("error", (cause) => {
  fatal(`ao spawn failed: ${stringifyCause(cause)}`);
});

child.once("close", (code) => {
  process.exit(code ?? 1);
});

function resolveOrchestratorSenderId(): string {
  const explicit = trimEnv(process.env.MOLTZAP_LOCAL_SENDER_ID);
  if (explicit !== null) {
    return explicit;
  }
  const dataDir = trimEnv(process.env.AO_DATA_DIR);
  const sessionId = trimEnv(process.env.AO_SESSION);
  if (dataDir === null || sessionId === null) {
    fatal("AO_DATA_DIR and AO_SESSION are required to resolve the orchestrator sender ID");
  }
  const metadataPath = `${dataDir}/${sessionId}`;
  try {
    const content = readFileSync(metadataPath, "utf8");
    for (const line of content.split("\n")) {
      if (line.startsWith("moltzap_sender_id=")) {
        const value = line.slice("moltzap_sender_id=".length).trim();
        if (value.length > 0) {
          return value;
        }
      }
    }
  } catch (cause) {
    fatal(`failed to read orchestrator metadata: ${stringifyCause(cause)}`);
  }
  fatal(`moltzap_sender_id not found in ${metadataPath}`);
}

function trimEnv(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stringifyCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function fatal(message: string): never {
  console.error(`[ao-spawn-with-moltzap] ${message}`);
  process.exit(1);
}
