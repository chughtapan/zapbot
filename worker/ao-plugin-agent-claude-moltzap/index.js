import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const builtinModule = await import(pathToFileURL(resolveBuiltinClaudePluginPath()).href);
const builtin = builtinModule.create();
const launchWrapperPath = fileURLToPath(new URL("./launch-claude-moltzap.py", import.meta.url));

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
        ...pickPassthroughEnv([
          "GH_TOKEN",
          "GITHUB_TOKEN",
          "MOLTZAP_SERVER_URL",
          "MOLTZAP_API_KEY",
          "MOLTZAP_LOCAL_SENDER_ID",
          "MOLTZAP_ORCHESTRATOR_SENDER_ID",
          "MOLTZAP_ALLOWED_SENDERS",
          "MOLTZAP_REGISTRATION_SECRET",
        ]),
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
            env: pickPassthroughEnv([
              "MOLTZAP_SERVER_URL",
              "MOLTZAP_API_KEY",
              "MOLTZAP_LOCAL_SENDER_ID",
              "MOLTZAP_ORCHESTRATOR_SENDER_ID",
              "MOLTZAP_ALLOWED_SENDERS",
              "MOLTZAP_REGISTRATION_SECRET",
            ]),
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
    const value = process.env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      env[key] = value;
    }
  }
  return env;
}

function sanitizeClaudeChannelEnv(env) {
  const next = { ...env };
  delete next.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
  return next;
}

function shellEscape(value) {
  return "'" + String(value).replace(/'/g, "'\"'\"'") + "'";
}

export default { manifest, create, detect };
