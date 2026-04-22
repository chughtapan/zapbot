#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  createManagedSessionFileRegistry,
  managedSessionIdFromSessionName,
  resolveManagedSessionRegistryPath,
  type ManagedSessionRecord,
  type ManagedSessionRegistryError,
} from "../src/lifecycle/contracts.ts";
import { asAoSessionName, asProjectName } from "../src/types.ts";

const MOLTZAP_ENV_FALLBACKS = {
  MOLTZAP_SERVER_URL: "ZAPBOT_MOLTZAP_SERVER_URL",
  MOLTZAP_API_KEY: "ZAPBOT_MOLTZAP_API_KEY",
  MOLTZAP_ALLOWED_SENDERS: "ZAPBOT_MOLTZAP_ALLOWED_SENDERS",
  MOLTZAP_REGISTRATION_SECRET: "ZAPBOT_MOLTZAP_REGISTRATION_SECRET",
} as const;

interface WorkerSessionMetadata {
  readonly worktree: string;
  readonly tmuxName: string;
  readonly apiKey: string | null;
  readonly localSenderId: string | null;
}

export interface ManagedWorkerRegistrationOptions {
  readonly sessionName: string;
  readonly projectId: string;
  readonly configPath: string;
  readonly worktree: string;
  readonly tmuxName: string;
  readonly now?: () => number;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (argv.length === 0) {
    fatal("usage: bun run bin/ao-spawn-with-moltzap.ts <issue-number> | --prompt <text>");
  }

  const moltzapEnvFile = readZapbotEnvFile();
  const sessionDataDir = requireEnv("AO_DATA_DIR", moltzapEnvFile);
  const currentSession = requireEnv("AO_SESSION", moltzapEnvFile);
  const projectId = trimEnv(process.env.AO_PROJECT_ID) ?? "zapbot";
  const configPath = trimEnv(process.env.AO_CONFIG_PATH) ?? "";
  const orchestratorSenderId = resolveMetadataValue(
    currentSession,
    "moltzap_sender_id",
    sessionDataDir,
  ) ?? fatal("moltzap_sender_id not found in orchestrator metadata");
  const serverUrl = requireEnv("MOLTZAP_SERVER_URL", moltzapEnvFile);
  const registrationSecret = requireEnv(
    "MOLTZAP_REGISTRATION_SECRET",
    moltzapEnvFile,
  );
  const beforeSessions = new Set(listSessionNames(sessionDataDir));

  const childEnv: Record<string, string> = {
    ...process.env,
    AO_CONFIG_PATH: configPath,
    AO_PROJECT_ID: projectId,
    MOLTZAP_SERVER_URL: serverUrl,
    MOLTZAP_REGISTRATION_SECRET: registrationSecret,
    MOLTZAP_ORCHESTRATOR_SENDER_ID: orchestratorSenderId,
  };
  delete childEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;

  const allowedSenders = resolveRuntimeEnv("MOLTZAP_ALLOWED_SENDERS", moltzapEnvFile);
  if (allowedSenders !== null) {
    childEnv.MOLTZAP_ALLOWED_SENDERS = allowedSenders;
  }

  const spawnedSession = await runAoSpawn(argv, childEnv, {
    sessionDataDir,
    currentSession,
    beforeSessions,
  });
  await ensureWorkerChannelsReady({
    sessionName: spawnedSession,
    sessionDataDir,
    projectId,
    configPath,
    orchestratorSenderId,
    serverUrl,
  });
}

export async function upsertManagedWorkerRegistration(
  options: ManagedWorkerRegistrationOptions,
): Promise<ManagedSessionRecord> {
  const projectName = asProjectName(options.projectId);
  const sessionName = asAoSessionName(options.sessionName);
  const sessionId = managedSessionIdFromSessionName(sessionName);
  const registry = createManagedSessionFileRegistry({
    registryPath: resolveManagedSessionRegistryPath({
      configPath: options.configPath,
    }),
  });

  const existing = await registry.get(sessionId);
  if (existing._tag === "Err") {
    throw new Error(stringifyRegistryError(existing.error));
  }

  const now = options.now?.() ?? Date.now();
  const claimedAtMs =
    existing.value !== null && existing.value.tag.projectName === projectName
      ? existing.value.tag.claimedAtMs
      : now;
  const record: ManagedSessionRecord = {
    id: sessionId,
    tag: {
      managed: true,
      owner: "zapbot",
      projectName,
      sessionName,
      scope: "worker",
      origin: "ao-spawn-with-moltzap.ts",
      claimedAtMs,
    },
    tmuxName: options.tmuxName,
    worktree: options.worktree,
    processId: existing.value?.processId ?? null,
    phase: "active",
    lastHeartbeatAtMs: now,
  };

  const stored = await registry.put(record);
  if (stored._tag === "Err") {
    throw new Error(stringifyRegistryError(stored.error));
  }
  return stored.value;
}

function listSessionNames(dataDir: string): string[] {
  if (!existsSync(dataDir)) return [];
  return readdirSync(dataDir).filter((name) => !name.startsWith("."));
}

async function runAoSpawn(
  args: readonly string[],
  env: Record<string, string>,
  options: {
    readonly sessionDataDir: string;
    readonly currentSession: string;
    readonly beforeSessions: ReadonlySet<string>;
  },
): Promise<string> {
  const child = spawn("ao", ["spawn", ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    const text = String(chunk);
    stdout += text;
    process.stdout.write(text);
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    const text = String(chunk);
    stderr += text;
    process.stderr.write(text);
  });

  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          stderr.trim().length > 0
            ? stderr.trim()
            : `ao spawn exited ${code ?? 1}`,
        ),
      );
    });
  }).catch((cause) => {
    fatal(`ao spawn failed: ${stringifyCause(cause)}`);
  });

  const explicit = stdout.match(/SESSION=([^\s]+)/);
  if (explicit !== null) {
    return explicit[1];
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const after = listSessionNames(options.sessionDataDir);
    const found = after.find(
      (name) => !options.beforeSessions.has(name) && name !== options.currentSession,
    );
    if (found !== undefined) {
      return found;
    }
    await sleep(250);
  }

  fatal("spawned session name could not be resolved");
}

async function ensureWorkerChannelsReady(options: {
  readonly sessionName: string;
  readonly sessionDataDir: string;
  readonly projectId: string;
  readonly configPath: string;
  readonly orchestratorSenderId: string;
  readonly serverUrl: string;
}): Promise<void> {
  const metadata = await waitForWorkerSessionMetadata(
    options.sessionName,
    options.sessionDataDir,
  );
  const managedRecord = await upsertManagedWorkerRegistration({
    sessionName: options.sessionName,
    projectId: options.projectId,
    configPath: options.configPath,
    worktree: metadata.worktree,
    tmuxName: metadata.tmuxName,
  }).catch((cause) => {
    fatal(
      `worker ${options.sessionName} managed-session registration failed: ${stringifyCause(cause)}`,
    );
  });
  const worktree = managedRecord.worktree ?? metadata.worktree;
  const tmuxName = managedRecord.tmuxName ?? metadata.tmuxName;

  const initialOutcome = await waitForChannelOutcome(worktree);
  if (initialOutcome === "registered") {
    return;
  }
  if (initialOutcome !== "skipped") {
    fatal(`worker ${options.sessionName} MoltZap channel did not come up`);
  }
  if (metadata.apiKey === null || metadata.localSenderId === null) {
    fatal(
      `worker ${options.sessionName} metadata missing worktree/tmuxName/moltzap_api_key/moltzap_sender_id`,
    );
  }

  const latestLog = readLatestChannelLog(worktree);
  if (latestLog === null) {
    fatal(`worker ${options.sessionName} MoltZap log could not be located`);
  }
  const claudeSessionId = latestLog.match(/"sessionId":"([^"]+)"/)?.[1];
  if (claudeSessionId === undefined) {
    fatal(`worker ${options.sessionName} latest MoltZap log is missing sessionId`);
  }

  await restartWorkerWithResume({
    sessionName: options.sessionName,
    tmuxName,
    worktree,
    projectId: options.projectId,
    configPath: options.configPath,
    sessionDataDir: options.sessionDataDir,
    serverUrl: options.serverUrl,
    apiKey: metadata.apiKey,
    localSenderId: metadata.localSenderId,
    orchestratorSenderId: options.orchestratorSenderId,
    claudeSessionId,
  });

  const resumedOutcome = await waitForChannelOutcome(worktree);
  if (resumedOutcome !== "registered") {
    fatal(
      `worker ${options.sessionName} MoltZap channel failed to register after resume (${resumedOutcome})`,
    );
  }
}

async function restartWorkerWithResume(options: {
  readonly sessionName: string;
  readonly tmuxName: string;
  readonly worktree: string;
  readonly projectId: string;
  readonly configPath: string;
  readonly sessionDataDir: string;
  readonly serverUrl: string;
  readonly apiKey: string;
  readonly localSenderId: string;
  readonly orchestratorSenderId: string;
  readonly claudeSessionId: string;
}): Promise<void> {
  await runCommand("tmux", ["kill-session", "-t", options.tmuxName], true);

  const wrapperPath = fileURLToPath(
    new URL(
      "../worker/ao-plugin-agent-claude-moltzap/launch-claude-moltzap.py",
      import.meta.url,
    ),
  );
  const launchCommand = [
    "claude",
    "--resume",
    shellSingleQuote(options.claudeSessionId),
    "--dangerously-skip-permissions",
    "--mcp-config",
    ".claude/moltzap-channel.mcp.json",
    "--dangerously-load-development-channels",
    "server:moltzap",
  ].join(" ");

  const env: Record<string, string> = {
    ...process.env,
    AO_SESSION: options.sessionName,
    AO_DATA_DIR: options.sessionDataDir,
    AO_PROJECT_ID: options.projectId,
    AO_CONFIG_PATH: options.configPath,
    AO_CALLER_TYPE: "agent",
    MOLTZAP_SERVER_URL: options.serverUrl,
    MOLTZAP_API_KEY: options.apiKey,
    MOLTZAP_LOCAL_SENDER_ID: options.localSenderId,
    MOLTZAP_ORCHESTRATOR_SENDER_ID: options.orchestratorSenderId,
  };
  delete env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;

  const command = [
    "python3",
    shellSingleQuote(wrapperPath),
    shellSingleQuote(launchCommand),
  ].join(" ");

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "tmux",
      ["new-session", "-d", "-s", options.tmuxName, "-c", options.worktree, command],
      {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          stderr.trim().length > 0
            ? stderr.trim()
            : `tmux new-session exited ${code ?? 1}`,
        ),
      );
    });
  }).catch((cause) => {
    fatal(`failed to relaunch worker ${options.sessionName}: ${stringifyCause(cause)}`);
  });
}

async function waitForChannelOutcome(
  worktree: string,
): Promise<"registered" | "skipped" | "failed" | "timeout"> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const content = readLatestChannelLog(worktree);
    if (content !== null) {
      if (content.includes("Channel notifications registered")) {
        return "registered";
      }
      if (content.includes("Channel notifications skipped")) {
        return "skipped";
      }
      if (
        content.includes("Connection failed") ||
        content.includes("registration failed")
      ) {
        return "failed";
      }
    }
    await sleep(250);
  }
  return "timeout";
}

function readLatestChannelLog(worktree: string): string | null {
  const cacheKey = worktree.replace(/[^A-Za-z0-9]/g, "-");
  const logDir = join(
    homedir(),
    ".cache/claude-cli-nodejs",
    cacheKey,
    "mcp-logs-moltzap",
  );
  if (!existsSync(logDir)) {
    return null;
  }
  const latest = readdirSync(logDir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .at(-1);
  if (latest === undefined) {
    return null;
  }
  return readFileSync(join(logDir, latest), "utf8");
}

async function waitForWorkerSessionMetadata(
  sessionName: string,
  sessionDataDir: string,
): Promise<WorkerSessionMetadata> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const metadata = tryReadWorkerSessionMetadata(sessionName, sessionDataDir);
    if (metadata !== null) {
      return metadata;
    }
    await sleep(250);
  }
  fatal(`worker ${sessionName} metadata missing worktree/tmuxName`);
}

function tryReadWorkerSessionMetadata(
  sessionName: string,
  sessionDataDir: string,
): WorkerSessionMetadata | null {
  try {
    const metadata = readMetadata(sessionName, sessionDataDir);
    const worktree = metadata.get("worktree");
    const tmuxName = metadata.get("tmuxName");
    if (worktree === undefined || tmuxName === undefined) {
      return null;
    }
    return {
      worktree,
      tmuxName,
      apiKey: metadata.get("moltzap_api_key") ?? null,
      localSenderId: metadata.get("moltzap_sender_id") ?? null,
    };
  } catch {
    return null;
  }
}

function readMetadata(
  sessionName: string,
  sessionDataDir: string,
): Map<string, string> {
  const content = readFileSync(join(sessionDataDir, sessionName), "utf8");
  const entries = new Map<string, string>();
  for (const line of content.split("\n")) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index);
    const value = line.slice(index + 1).trim();
    if (value.length > 0) {
      entries.set(key, value);
    }
  }
  return entries;
}

function resolveMetadataValue(
  sessionName: string,
  key: string,
  sessionDataDir: string,
): string | null {
  try {
    return readMetadata(sessionName, sessionDataDir).get(key) ?? null;
  } catch {
    return null;
  }
}

async function runCommand(
  command: string,
  args: string[],
  allowFailure = false,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0 || allowFailure) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim().length > 0 ? stderr.trim() : `${command} exited ${code ?? 1}`));
    });
  });
}

function requireEnv(name: string, moltzapEnvFile: Record<string, string>): string {
  const value = resolveRuntimeEnv(name, moltzapEnvFile);
  if (value === null) {
    fatal(`${name} is required`);
  }
  return value;
}

function resolveRuntimeEnv(
  name: string,
  moltzapEnvFile: Record<string, string>,
): string | null {
  const direct = trimEnv(process.env[name]);
  if (direct !== null) {
    return direct;
  }

  const fallbackKey = MOLTZAP_ENV_FALLBACKS[name as keyof typeof MOLTZAP_ENV_FALLBACKS];
  if (fallbackKey !== undefined) {
    const mappedProcessValue = trimEnv(process.env[fallbackKey]);
    if (mappedProcessValue !== null) {
      return mappedProcessValue;
    }
  }

  const fileValue = trimEnv(moltzapEnvFile[name]);
  if (fileValue !== null) {
    return fileValue;
  }

  if (fallbackKey !== undefined) {
    const mappedFileValue = trimEnv(moltzapEnvFile[fallbackKey]);
    if (mappedFileValue !== null) {
      return mappedFileValue;
    }
  }

  return null;
}

function trimEnv(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function shellSingleQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function stringifyCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readZapbotEnvFile(): Record<string, string> {
  const path = trimEnv(process.env.ZAPBOT_ENV_PATH) ?? join(homedir(), ".zapbot", ".env");
  if (!existsSync(path)) {
    return {};
  }

  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const normalized = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const index = normalized.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key = normalized.slice(0, index).trim();
    const value = stripWrappingQuotes(normalized.slice(index + 1).trim());
    if (key.length > 0 && value.length > 0) {
      env[key] = value;
    }
  }
  return env;
}

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function fatal(message: string): never {
  console.error(`[ao-spawn-with-moltzap] ${message}`);
  process.exit(1);
}

function stringifyRegistryError(error: ManagedSessionRegistryError): string {
  switch (error._tag) {
    case "ManagedSessionRegistryUnavailable":
      return error.cause;
    case "ManagedSessionRecordCorrupt":
      return error.reason;
    case "ManagedSessionAlreadyOwned":
    case "ManagedSessionNotFound":
      return error.sessionId;
  }
}

function isMainModule(moduleUrl: string, entryPoint: string | undefined): boolean {
  if (typeof entryPoint !== "string" || entryPoint.length === 0) {
    return false;
  }
  return resolve(entryPoint) === fileURLToPath(moduleUrl);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  await main().catch((cause) => {
    fatal(stringifyCause(cause));
  });
}
