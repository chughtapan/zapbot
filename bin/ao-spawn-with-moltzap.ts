#!/usr/bin/env bun

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const issue = process.argv[2];
if (typeof issue !== "string" || issue.trim().length === 0) {
  fatal("usage: bun run bin/ao-spawn-with-moltzap.ts <issue-number>");
}

const sessionDataDir = requireEnv("AO_DATA_DIR");
const currentSession = requireEnv("AO_SESSION");
const projectId = trimEnv(process.env.AO_PROJECT_ID) ?? "zapbot";
const configPath = trimEnv(process.env.AO_CONFIG_PATH) ?? "";
const orchestratorSenderId = resolveMetadataValue(
  currentSession,
  "moltzap_sender_id",
) ?? fatal("moltzap_sender_id not found in orchestrator metadata");
const serverUrl = requireEnv("MOLTZAP_SERVER_URL");
const registrationSecret = requireEnv("MOLTZAP_REGISTRATION_SECRET");
const beforeSessions = new Set(listSessionNames(sessionDataDir));

const childEnv: Record<string, string> = {
  ...process.env,
  AO_CONFIG_PATH: configPath,
  AO_PROJECT_ID: projectId,
  MOLTZAP_SERVER_URL: serverUrl,
  MOLTZAP_REGISTRATION_SECRET: registrationSecret,
  MOLTZAP_ORCHESTRATOR_SENDER_ID: orchestratorSenderId,
};

const allowedSenders = trimEnv(process.env.MOLTZAP_ALLOWED_SENDERS);
if (allowedSenders !== null) {
  childEnv.MOLTZAP_ALLOWED_SENDERS = allowedSenders;
}

const spawnedSession = await runAoSpawn(issue, childEnv);
await ensureWorkerChannelsReady({
  sessionName: spawnedSession,
  sessionDataDir,
  projectId,
  configPath,
  orchestratorSenderId,
  serverUrl,
});

function listSessionNames(dataDir: string): string[] {
  if (!existsSync(dataDir)) return [];
  return readdirSync(dataDir).filter((name) => !name.startsWith("."));
}

async function runAoSpawn(
  issueNumber: string,
  env: Record<string, string>,
): Promise<string> {
  const child = spawn("ao", ["spawn", issueNumber], {
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
    const after = listSessionNames(sessionDataDir);
    const found = after.find(
      (name) => !beforeSessions.has(name) && name !== currentSession,
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
  const initialOutcome = await waitForChannelOutcome(options.sessionName);
  if (initialOutcome === "registered") {
    return;
  }
  if (initialOutcome !== "skipped") {
    fatal(`worker ${options.sessionName} MoltZap channel did not come up`);
  }

  const metadata = readMetadata(options.sessionName);
  const worktree = metadata.get("worktree");
  const tmuxName = metadata.get("tmuxName");
  const apiKey = metadata.get("moltzap_api_key");
  const localSenderId = metadata.get("moltzap_sender_id");
  if (
    worktree === undefined ||
    tmuxName === undefined ||
    apiKey === undefined ||
    localSenderId === undefined
  ) {
    fatal(
      `worker ${options.sessionName} metadata missing worktree/tmuxName/moltzap_api_key/moltzap_sender_id`,
    );
  }

  const latestLog = readLatestChannelLog(options.sessionName);
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
    apiKey,
    localSenderId,
    orchestratorSenderId: options.orchestratorSenderId,
    claudeSessionId,
  });

  const resumedOutcome = await waitForChannelOutcome(options.sessionName);
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

  const env = {
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
  sessionName: string,
): Promise<"registered" | "skipped" | "failed" | "timeout"> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const content = readLatestChannelLog(sessionName);
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

function readLatestChannelLog(sessionName: string): string | null {
  const metadata = readMetadata(sessionName);
  const worktree = metadata.get("worktree");
  if (worktree === undefined) {
    return null;
  }
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

function readMetadata(sessionName: string): Map<string, string> {
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
): string | null {
  try {
    return readMetadata(sessionName).get(key) ?? null;
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

function requireEnv(name: string): string {
  const value = trimEnv(process.env[name]);
  if (value === null) {
    fatal(`${name} is required`);
  }
  return value;
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

function fatal(message: string): never {
  console.error(`[ao-spawn-with-moltzap] ${message}`);
  process.exit(1);
}
