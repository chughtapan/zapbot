import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const builtinModule = await import(pathToFileURL(resolveBuiltinClaudePluginPath()).href);
const builtin = builtinModule.create();
const autoConfirmScriptPath = fileURLToPath(
  new URL("../../bin/confirm-claude-channel.ts", import.meta.url),
);
const execFileAsync = promisify(execFile);

export const manifest = {
  ...builtinModule.manifest,
  name: "claude-moltzap",
  description: "Claude Code with a repo-local MoltZap Claude channel",
};

export function create() {
  return {
    ...builtin,
    name: "claude-moltzap",
    getLaunchCommand(config) {
      return withClaudeChannelFlags(builtin.getLaunchCommand(config));
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
      if (session?.runtimeHandle?.runtimeName === "tmux" && session.runtimeHandle.id) {
        await runChannelPromptAutoConfirm(session.runtimeHandle.id);
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
      return withClaudeChannelFlags(baseCommand);
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

function ensureChannelMcpConfig(workspacePath) {
  const configPath = join(workspacePath, relativeMcpConfigPath());
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        mcpServers: {
          moltzap: {
            command: "bun",
            args: [join(workspacePath, "bin", "moltzap-claude-channel.ts")],
            env: resolveMoltzapRuntimeEnv(),
          },
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
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
  const env = {};
  for (const key of [
    "MOLTZAP_SERVER_URL",
    "MOLTZAP_API_KEY",
    "MOLTZAP_LOCAL_SENDER_ID",
    "MOLTZAP_ORCHESTRATOR_SENDER_ID",
    "MOLTZAP_ALLOWED_SENDERS",
    "MOLTZAP_REGISTRATION_SECRET",
  ]) {
    const value = resolveEnvValue(key);
    if (value !== null) {
      env[key] = value;
    }
  }
  return env;
}

function resolveEnvValue(key) {
  const direct = normalizeEnvValue(process.env[key]);
  if (direct !== null) {
    return direct;
  }
  return null;
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

function withClaudeChannelFlags(command) {
  return [
    command,
    "--mcp-config",
    shellEscape(relativeMcpConfigPath()),
    "--dangerously-load-development-channels",
    "server:moltzap",
  ].join(" ");
}

async function runChannelPromptAutoConfirm(tmuxTarget) {
  await execFileAsync("bun", [autoConfirmScriptPath, "--tmux-target", tmuxTarget], {
    timeout: 20_000,
  });
}

export default { manifest, create, detect };
