import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const builtinModule = await import(pathToFileURL(resolveBuiltinClaudePluginPath()).href);
const builtin = builtinModule.create();
const launchWrapperPath = fileURLToPath(new URL("./launch-claude-moltzap.py", import.meta.url));
const execFileAsync = promisify(execFile);
const MOLTZAP_ENV_FALLBACKS = Object.freeze({
  MOLTZAP_SERVER_URL: "ZAPBOT_MOLTZAP_SERVER_URL",
  MOLTZAP_API_KEY: "ZAPBOT_MOLTZAP_API_KEY",
  MOLTZAP_ALLOWED_SENDERS: "ZAPBOT_MOLTZAP_ALLOWED_SENDERS",
  MOLTZAP_REGISTRATION_SECRET: "ZAPBOT_MOLTZAP_REGISTRATION_SECRET",
});

export const manifest = {
  ...builtinModule.manifest,
  name: "claude-moltzap",
  description: "Claude Code with a repo-local MoltZap Claude channel",
};

export function create() {
  return {
    ...builtin,
    name: "claude-moltzap",
    processName: "bash",
    getLaunchCommand(config) {
      const command = [
        builtin.getLaunchCommand(config),
        "--mcp-config",
        shellEscape(relativeMcpConfigPath()),
        "--dangerously-load-development-channels",
        "server:moltzap",
      ].join(" ");
      return [
        "python3",
        shellEscape(launchWrapperPath),
        shellEscape(command),
      ].join(" ");
    },
    getEnvironment(config) {
      const baseEnv = sanitizeClaudeChannelEnv(builtin.getEnvironment(config));
      return {
        ...baseEnv,
        ...pickPassthroughEnv(["GH_TOKEN", "GITHUB_TOKEN"]),
        ...resolveMoltzapRuntimeEnv(),
      };
    },
    async setupWorkspaceHooks(workspacePath, config) {
      if (typeof builtin.setupWorkspaceHooks === "function") {
        await builtin.setupWorkspaceHooks(workspacePath, config);
      }
      ensureChannelMcpConfig(workspacePath);
    },
    async postLaunchSetup(session) {
      if (typeof builtin.postLaunchSetup === "function") {
        await builtin.postLaunchSetup(session);
      }
      if (session?.workspacePath) {
        ensureChannelMcpConfig(session.workspacePath);
      }
    },
    async getRestoreCommand(session, project) {
      if (typeof builtin.getRestoreCommand !== "function") {
        return null;
      }
      const baseCommand = await builtin.getRestoreCommand(session, project);
      if (!baseCommand) {
        return null;
      }
      if (session?.workspacePath) {
        ensureChannelMcpConfig(session.workspacePath);
      }
      return wrapClaudeCommand(baseCommand);
    },
    async isProcessRunning(handle) {
      if (typeof builtin.isProcessRunning === "function" && (await builtin.isProcessRunning(handle))) {
        return true;
      }
      return isWrapperProcessRunning(handle);
    },
  };
}

export function detect() {
  return typeof builtinModule.detect === "function" ? builtinModule.detect() : true;
}

function resolveBuiltinClaudePluginPath() {
  const bunInstall = process.env.BUN_INSTALL;
  const explicit = process.env.AO_BUILTIN_CLAUDE_PLUGIN_PATH;
  const candidates = [
    explicit ?? null,
    bunInstall
      ? join(
          bunInstall,
          "install/global/node_modules/@aoagents/ao-plugin-agent-claude-code/dist/index.js",
        )
      : null,
    join(
      homedir(),
      ".bun/install/global/node_modules/@aoagents/ao-plugin-agent-claude-code/dist/index.js",
    ),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "Could not resolve the global @aoagents/ao-plugin-agent-claude-code install. Set BUN_INSTALL or AO_BUILTIN_CLAUDE_PLUGIN_PATH if your AO install lives elsewhere.",
  );
}

/**
 * Boundary decode for an existing `.claude/moltzap-channel.mcp.json`. Principle 2.
 *
 * Anchors: SPEC r4.1 Invariant 4 (reserved-key collision fail-fast),
 *          Invariant 5 (boundary decode for mcpServers merge).
 *
 * Returns one of:
 *   { kind: "absent" }                           — no config; safe to write ours.
 *   { kind: "ours" }                             — file is a well-formed mcp
 *                                                   config whose only server is
 *                                                   "moltzap"; safe to overwrite.
 *   { kind: "mergeable", existing: {...} }       — file decodes; mcpServers has
 *                                                   no "moltzap" key; we can
 *                                                   merge our entry in.
 *   { kind: "shapeInvalid", reason }             — file fails to decode.
 *   { kind: "reservedKeyCollision" }             — existing file has a
 *                                                   "moltzap" mcpServers entry
 *                                                   we did not author. Fail-fast.
 */
function decodeExistingMcpConfig(configPath) {
  if (!existsSync(configPath)) {
    return { kind: "absent" };
  }
  let rawText;
  try {
    rawText = readFileSync(configPath, "utf8");
  } catch (e) {
    return { kind: "shapeInvalid", reason: `read failed: ${String(e && e.message ? e.message : e)}` };
  }
  if (typeof rawText !== "string" || rawText.trim().length === 0) {
    return { kind: "shapeInvalid", reason: "config file is empty" };
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    return { kind: "shapeInvalid", reason: `invalid JSON: ${String(e && e.message ? e.message : e)}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "shapeInvalid", reason: "top-level value must be an object" };
  }
  const mcpServers = parsed.mcpServers;
  if (mcpServers === undefined) {
    return { kind: "mergeable", existing: parsed };
  }
  if (mcpServers === null || typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
    return { kind: "shapeInvalid", reason: "mcpServers must be an object" };
  }
  // Enumerate keys in a stable manner so behavior is deterministic across runs.
  const keys = Object.keys(mcpServers);
  if (keys.includes("moltzap")) {
    // Distinguish "ours" from "collision":
    // - New marker: `_zapbotAuthored: true` on the moltzap entry.
    // - Legacy marker (pre-sbd#149): entry has `command: "bun"` and an
    //   `args` array ending with `moltzap-claude-channel.ts`. Upgraded
    //   workspaces still carry this shape; treating them as foreign
    //   collisions would break launch until the user deletes the file.
    // Absent either marker, treat as foreign (Invariant 4 fail-fast).
    const moltzapEntry = mcpServers.moltzap;
    if (
      moltzapEntry !== null &&
      typeof moltzapEntry === "object" &&
      !Array.isArray(moltzapEntry)
    ) {
      if (moltzapEntry._zapbotAuthored === true) {
        return { kind: "ours", existing: parsed };
      }
      // Legacy zapbot shape: command === "bun" and args ends with
      // moltzap-claude-channel.ts.
      if (
        moltzapEntry.command === "bun" &&
        Array.isArray(moltzapEntry.args) &&
        moltzapEntry.args.length > 0 &&
        typeof moltzapEntry.args[moltzapEntry.args.length - 1] === "string" &&
        moltzapEntry.args[moltzapEntry.args.length - 1].endsWith(
          "moltzap-claude-channel.ts",
        )
      ) {
        // Re-write as ours to stamp the new marker on next writeFileSync.
        return { kind: "ours", existing: parsed };
      }
    }
    return { kind: "reservedKeyCollision" };
  }
  return { kind: "mergeable", existing: parsed };
}

function buildMoltzapMcpEntry(workspacePath) {
  return {
    command: "bun",
    args: [join(workspacePath, "bin", "moltzap-claude-channel.ts")],
    env: resolveMoltzapRuntimeEnv(),
    _zapbotAuthored: true,
  };
}

function ensureChannelMcpConfig(workspacePath) {
  const configPath = join(workspacePath, relativeMcpConfigPath());
  mkdirSync(dirname(configPath), { recursive: true });

  const decoded = decodeExistingMcpConfig(configPath);

  if (decoded.kind === "reservedKeyCollision") {
    // Invariant 4: the "moltzap" mcpServers key is reserved for this plugin.
    // Fail-fast with a typed error rather than silently overwriting.
    const err = new Error(
      "ReservedMcpKeyCollision: existing .claude/moltzap-channel.mcp.json " +
        `already defines an mcpServers.moltzap entry at ${configPath} that ` +
        "was not authored by zapbot. Remove or rename the foreign entry " +
        "before launching a MoltZap-aware Claude session.",
    );
    err.code = "ReservedMcpKeyCollision";
    err.path = configPath;
    throw err;
  }

  if (decoded.kind === "shapeInvalid") {
    const err = new Error(
      `McpConfigShapeInvalid: ${configPath} could not be decoded: ${decoded.reason}. ` +
        "Delete or repair the file before launching.",
    );
    err.code = "McpConfigShapeInvalid";
    err.path = configPath;
    throw err;
  }

  // Merge our entry in. Both "mergeable" (no moltzap key yet) and "ours"
  // (our existing moltzap entry) carry the decoded document on `existing`;
  // either way, reuse it as the base so user-added top-level keys and
  // sibling mcpServers entries survive rewrites.
  const base =
    (decoded.kind === "mergeable" || decoded.kind === "ours") &&
    decoded.existing &&
    typeof decoded.existing === "object"
      ? decoded.existing
      : {};
  const existingServers =
    base.mcpServers && typeof base.mcpServers === "object" && !Array.isArray(base.mcpServers)
      ? base.mcpServers
      : {};
  const merged = {
    ...base,
    mcpServers: {
      ...existingServers,
      moltzap: buildMoltzapMcpEntry(workspacePath),
    },
  };

  writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
}

function relativeMcpConfigPath() {
  return ".claude/moltzap-channel.mcp.json";
}

function pickPassthroughEnv(keys) {
  const env = {};
  for (const key of keys) {
    const value = normalizeEnvValue(process.env[key]);
    if (value !== null) {
      env[key] = value;
    }
  }
  return env;
}

function resolveMoltzapRuntimeEnv() {
  const fileEnv = readZapbotEnvFile();
  const env = {};
  for (const key of [
    "MOLTZAP_SERVER_URL",
    "MOLTZAP_API_KEY",
    "MOLTZAP_LOCAL_SENDER_ID",
    "MOLTZAP_ORCHESTRATOR_SENDER_ID",
    "MOLTZAP_ALLOWED_SENDERS",
    "MOLTZAP_REGISTRATION_SECRET",
  ]) {
    const value = resolveEnvValue(key, fileEnv);
    if (value !== null) {
      env[key] = value;
    }
  }
  return env;
}

function resolveEnvValue(key, fileEnv) {
  const direct = normalizeEnvValue(process.env[key]);
  if (direct !== null) {
    return direct;
  }

  const fallbackKey = MOLTZAP_ENV_FALLBACKS[key];
  if (typeof fallbackKey === "string") {
    const mappedProcessValue = normalizeEnvValue(process.env[fallbackKey]);
    if (mappedProcessValue !== null) {
      return mappedProcessValue;
    }
  }

  const fileValue = normalizeEnvValue(fileEnv[key]);
  if (fileValue !== null) {
    return fileValue;
  }

  if (typeof fallbackKey === "string") {
    const mappedFileValue = normalizeEnvValue(fileEnv[fallbackKey]);
    if (mappedFileValue !== null) {
      return mappedFileValue;
    }
  }

  return null;
}

function readZapbotEnvFile() {
  const path =
    normalizeEnvValue(process.env.ZAPBOT_ENV_PATH) ?? join(homedir(), ".zapbot", ".env");
  if (!existsSync(path)) {
    return {};
  }

  const env = {};
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

function stripWrappingQuotes(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizeEnvValue(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sanitizeClaudeChannelEnv(env) {
  const next = { ...env };
  delete next.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
  return next;
}

function shellEscape(value) {
  return "'" + String(value).replace(/'/g, "'\"'\"'") + "'";
}

function wrapClaudeCommand(command) {
  const withChannel = [
    command,
    "--mcp-config",
    shellEscape(relativeMcpConfigPath()),
    "--dangerously-load-development-channels",
    "server:moltzap",
  ].join(" ");
  return [
    "python3",
    shellEscape(launchWrapperPath),
    shellEscape(withChannel),
  ].join(" ");
}

async function isWrapperProcessRunning(handle) {
  if (handle?.runtimeName !== "tmux" || !handle.id) {
    return false;
  }

  let ttyOutput = "";
  try {
    const { stdout } = await execFileAsync(
      "tmux",
      ["list-panes", "-t", handle.id, "-F", "#{pane_tty}"],
      { timeout: 5_000 },
    );
    ttyOutput = stdout;
  } catch {
    return false;
  }

  const ttys = ttyOutput
    .trim()
    .split("\n")
    .map((tty) => tty.trim())
    .filter(Boolean)
    .map((tty) => tty.replace(/^\/dev\//, ""));

  if (ttys.length === 0) {
    return false;
  }

  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-eo", "tty=,args="],
      { timeout: 5_000, maxBuffer: 1024 * 1024 },
    );
    const ttySet = new Set(ttys);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .some((line) => {
        if (line.length === 0) {
          return false;
        }
        const [tty, ...rest] = line.split(/\s+/);
        if (tty === undefined || !ttySet.has(tty)) {
          return false;
        }
        const args = rest.join(" ");
        return args.includes("launch-claude-moltzap.py");
      });
  } catch {
    return false;
  }
}

export default { manifest, create, detect };
