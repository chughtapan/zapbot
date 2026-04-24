#!/usr/bin/env bun

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { scrubMoltzapForbiddenEnv } from "../src/moltzap/runtime.ts";
import { decodeSessionRole } from "../src/moltzap/session-role.ts";

const rawArgs = process.argv.slice(2);
if (rawArgs.length === 0) {
  fatal("usage: bun run bin/ao-spawn-with-moltzap.ts <issue-number> | --prompt <text>");
}

// Parse zapbot-level flags that the orchestrator injects (see
// `src/orchestrator/runtime.ts:647-658`). These flags are NOT consumed by
// `ao spawn` itself (run `ao spawn --help` to verify). Leaving them in the
// argv passed to `ao` meant `ao` silently ignored them AND the worker
// subprocess inherited `AO_CALLER_TYPE=orchestrator` from the bridge, so
// every worker's `resolveRole()` returned "orchestrator" — the
// showstopper flagged in reviewer-328's Blocker #1.
//
// Extract `--role <role>` into `ZAPBOT_SESSION_ROLE` on the child env.
// `--label <label>` and `--project <project>` are currently informational
// only and are stripped so they do not pollute `ao spawn`'s positional
// args.
const { spawnArgs, sessionRole, displayLabel, projectArg } = partitionArgs(rawArgs);

const moltzapEnvFile = readZapbotEnvFile();
const MOLTZAP_ENV_FALLBACKS = {
  MOLTZAP_SERVER_URL: "ZAPBOT_MOLTZAP_SERVER_URL",
  MOLTZAP_API_KEY: "ZAPBOT_MOLTZAP_API_KEY",
} as const;

const sessionDataDir = requireEnv("AO_DATA_DIR");
const currentSession = requireEnv("AO_SESSION");
const projectId = trimEnv(process.env.AO_PROJECT_ID) ?? projectArg ?? "zapbot";
const configPath = trimEnv(process.env.AO_CONFIG_PATH) ?? "";
const orchestratorSenderId = resolveMetadataValue(
  currentSession,
  "moltzap_sender_id",
) ?? fatal("moltzap_sender_id not found in orchestrator metadata");
const serverUrl = requireEnv("MOLTZAP_SERVER_URL");
// Spec rev 2 Invariant 4: `MOLTZAP_REGISTRATION_SECRET` must NEVER reach
// a worker. The wrapper requires a pre-minted `MOLTZAP_API_KEY` in its own
// env (minted by the bridge via `buildMoltzapSpawnEnv` in
// `src/moltzap/runtime.ts`). If a caller still sets the secret in parent
// env (legacy bridge configs), `buildWorkerEnv` explicitly scrubs it from
// the child env so every worker path is safe regardless of caller hygiene.
const apiKey = requireEnv("MOLTZAP_API_KEY");
const localSenderIdFromEnv = trimEnv(process.env.MOLTZAP_LOCAL_SENDER_ID);
const beforeSessions = new Set(listSessionNames(sessionDataDir));

void displayLabel; // currently informational only; stripped from `ao spawn` argv

const childEnv = buildWorkerEnv({
  aoConfigPath: configPath,
  aoProjectId: projectId,
  serverUrl,
  apiKey,
  orchestratorSenderId,
  localSenderId: localSenderIdFromEnv ?? undefined,
  sessionRole: sessionRole ?? undefined,
});

const spawnedSession = await runAoSpawn(spawnArgs, childEnv);
await ensureWorkerChannelsReady({
  sessionName: spawnedSession,
  sessionDataDir,
  projectId,
  configPath,
  orchestratorSenderId,
  serverUrl,
});

// Emit the worker's real runtime-assigned MOLTZAP_LOCAL_SENDER_ID to
// stdout so the bridge-side RosterManager can record the actual sender
// id (not a fabricated one). Format is a stable key=value line that
// `src/orchestrator/runtime.ts` parses (stamina round 3 P1 fix).
try {
  const finalMetadata = readMetadata(spawnedSession);
  const finalSenderId = finalMetadata.get("moltzap_sender_id");
  if (finalSenderId !== undefined) {
    process.stdout.write(`MOLTZAP_LOCAL_SENDER_ID=${finalSenderId}\n`);
  }
} catch {
  // Metadata read is best-effort here; the bridge falls back to a
  // derived sender id and logs a diagnostic if this line is missing.
}

function listSessionNames(dataDir: string): string[] {
  if (!existsSync(dataDir)) return [];
  return readdirSync(dataDir).filter((name) => !name.startsWith("."));
}

interface PartitionedArgs {
  readonly spawnArgs: string[];
  readonly sessionRole: string | null;
  readonly displayLabel: string | null;
  readonly projectArg: string | null;
}

/**
 * Strip zapbot-level flags (`--role`, `--label`, `--project`) from the
 * argv and return them alongside the remaining args that get forwarded to
 * `ao spawn`. Blocker #1 fix (reviewer-328): the role flag was previously
 * forwarded blindly to `ao spawn` (which ignored it), so
 * `ZAPBOT_SESSION_ROLE` never reached the worker and every spawned worker
 * inherited `AO_CALLER_TYPE=orchestrator` from the bridge.
 *
 * The `--role` value is validated against the `SessionRole` decoder so a
 * typo fails fast in the wrapper instead of misrouting at the worker.
 */
function partitionArgs(args: readonly string[]): PartitionedArgs {
  const spawnArgs: string[] = [];
  let sessionRole: string | null = null;
  let displayLabel: string | null = null;
  let projectArg: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--role" || arg === "--label" || arg === "--project") {
      const value = args[index + 1];
      if (typeof value !== "string" || value.length === 0) {
        fatal(`${arg} requires a value`);
      }
      index += 1;
      if (arg === "--role") {
        const decoded = decodeSessionRole(value);
        if (decoded._tag === "Err") {
          fatal(
            `--role must be one of orchestrator|architect|implementer|reviewer (got "${value}")`,
          );
        }
        sessionRole = decoded.value;
      } else if (arg === "--label") {
        displayLabel = value;
      } else {
        projectArg = value;
      }
      continue;
    }
    spawnArgs.push(arg);
  }

  return { spawnArgs, sessionRole, displayLabel, projectArg };
}

interface BuildWorkerEnvOptions {
  readonly aoSessionOverride?: string;
  readonly aoDataDir?: string;
  readonly aoConfigPath: string;
  readonly aoProjectId: string;
  readonly serverUrl: string;
  readonly apiKey: string;
  readonly orchestratorSenderId: string;
  readonly localSenderId?: string;
  readonly sessionRole?: string;
}

/**
 * Single construction point for the env every worker child process (both
 * the initial `ao spawn` and the `tmux new-session` resume restart)
 * receives. Spreads `process.env`, overwrites zapbot/MoltZap-owned keys,
 * runs `scrubMoltzapForbiddenEnv` to drop anything from
 * `MOLTZAP_WORKER_FORBIDDEN_ENV` (Invariant 4), and drops
 * `AO_CALLER_TYPE` so workers do NOT inherit the bridge's
 * `AO_CALLER_TYPE=orchestrator` (Blocker #1 fix — see `partitionArgs`).
 *
 * When `sessionRole` is provided it is written as `ZAPBOT_SESSION_ROLE`
 * on the child env so `bin/moltzap-claude-channel.ts :: resolveRole`
 * picks the correct 4-value role instead of falling back to the legacy
 * binary `AO_CALLER_TYPE` path (now deleted — Blocker #4 fix).
 */
function buildWorkerEnv(
  options: BuildWorkerEnvOptions,
): Record<string, string> {
  const env: Record<string, string> = {
    ...process.env,
    AO_CONFIG_PATH: options.aoConfigPath,
    AO_PROJECT_ID: options.aoProjectId,
    MOLTZAP_SERVER_URL: options.serverUrl,
    MOLTZAP_API_KEY: options.apiKey,
    MOLTZAP_ORCHESTRATOR_SENDER_ID: options.orchestratorSenderId,
  };
  if (options.aoSessionOverride !== undefined) {
    env.AO_SESSION = options.aoSessionOverride;
  }
  if (options.aoDataDir !== undefined) {
    env.AO_DATA_DIR = options.aoDataDir;
  }
  if (options.localSenderId !== undefined) {
    env.MOLTZAP_LOCAL_SENDER_ID = options.localSenderId;
  }
  if (options.sessionRole !== undefined) {
    env.ZAPBOT_SESSION_ROLE = options.sessionRole;
  }
  // Workers do NOT inherit `AO_CALLER_TYPE` from the bridge. The bridge
  // sets it to `"orchestrator"`, which — left in place — would make
  // every worker's `resolveRole()` short-circuit to "orchestrator"
  // (reviewer-328 Blocker #1).
  delete env.AO_CALLER_TYPE;
  scrubMoltzapForbiddenEnv(env);
  return env;
}

async function runAoSpawn(
  args: string[],
  env: Record<string, string>,
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

  // Blocker #2 (reviewer-328): the resume path previously only scrubbed
  // `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` while the initial-spawn
  // path correctly scrubbed the registration secret. Any restart leaked
  // the secret that the initial spawn had just suppressed. Both paths
  // now go through the same `buildWorkerEnv` so the Invariant 4 scrub
  // cannot drift.
  const env = buildWorkerEnv({
    aoSessionOverride: options.sessionName,
    aoDataDir: options.sessionDataDir,
    aoConfigPath: options.configPath,
    aoProjectId: options.projectId,
    serverUrl: options.serverUrl,
    apiKey: options.apiKey,
    orchestratorSenderId: options.orchestratorSenderId,
    localSenderId: options.localSenderId,
    sessionRole: sessionRole ?? undefined,
  });

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
  const value = resolveRuntimeEnv(name);
  if (value === null) {
    fatal(`${name} is required`);
  }
  return value;
}

function resolveRuntimeEnv(name: string): string | null {
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
