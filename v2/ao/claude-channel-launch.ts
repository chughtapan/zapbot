/**
 * v2/ao/claude-channel-launch — plan the Claude Code launch flags and
 * session-local MCP config needed to activate a MoltZap-backed custom channel.
 *
 * Architect phase only: public surface, no implementation.
 */

import type { Result } from "../types.ts";
import { err, ok } from "../types.ts";

export type ClaudeChannelEntry =
  | { readonly _tag: "DevelopmentServer"; readonly serverName: string }
  | {
      readonly _tag: "ApprovedPlugin";
      readonly pluginName: string;
      readonly marketplace: string;
    };

export interface SessionMcpServerConfig {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface ClaudeChannelLaunchPlan {
  readonly mcpConfigPath: string;
  readonly mcpConfigJson: string;
  readonly extraArgs: readonly string[];
  readonly entry: ClaudeChannelEntry;
}

export type ClaudeChannelLaunchPlanError =
  | { readonly _tag: "InvalidServerName"; readonly value: string }
  | { readonly _tag: "InvalidPluginReference"; readonly value: string }
  | { readonly _tag: "McpConfigInvalid"; readonly reason: string };

/**
 * Render the session-local MCP config JSON Claude Code will consume through
 * `--mcp-config`.
 */
export function renderSessionMcpConfig(
  server: SessionMcpServerConfig,
): Result<string, Extract<ClaudeChannelLaunchPlanError, { readonly _tag: "McpConfigInvalid" }>> {
  if (server.command.trim().length === 0) {
    return err({ _tag: "McpConfigInvalid", reason: "server.command must be a non-empty string" });
  }
  if (server.args.some((arg) => arg.trim().length === 0)) {
    return err({ _tag: "McpConfigInvalid", reason: "server.args must not contain empty strings" });
  }
  const invalidEnvKey = Object.entries(server.env).find(
    ([key, value]) => key.trim().length === 0 || value.trim().length === 0,
  );
  if (invalidEnvKey !== undefined) {
    return err({
      _tag: "McpConfigInvalid",
      reason: `server.env contains an invalid entry for ${invalidEnvKey[0] || "<empty>"}`,
    });
  }
  return ok(
    JSON.stringify(
      {
        mcpServers: {
          [server.name]: {
            command: server.command,
            args: [...server.args],
            env: { ...server.env },
          },
        },
      },
      null,
      2,
    ),
  );
}

/**
 * Produce the exact Claude CLI flags needed to activate either a development
 * server channel entry or an allowlisted plugin channel entry for this session.
 */
export function planClaudeChannelLaunch(input: {
  readonly server: SessionMcpServerConfig;
  readonly entry: ClaudeChannelEntry;
  readonly mcpConfigPath: string;
}): Result<ClaudeChannelLaunchPlan, ClaudeChannelLaunchPlanError> {
  if (!isValidEntryName(input.server.name)) {
    return err({ _tag: "InvalidServerName", value: input.server.name });
  }
  if (input.mcpConfigPath.trim().length === 0) {
    return err({ _tag: "McpConfigInvalid", reason: "mcpConfigPath must be a non-empty string" });
  }
  const mcpConfigJson = renderSessionMcpConfig(input.server);
  if (mcpConfigJson._tag === "Err") {
    return mcpConfigJson;
  }
  const entryArgs = toEntryArgs(input.entry, input.server.name);
  if (entryArgs._tag === "Err") {
    return entryArgs;
  }
  return ok({
    mcpConfigPath: input.mcpConfigPath,
    mcpConfigJson: mcpConfigJson.value,
    extraArgs: ["--mcp-config", input.mcpConfigPath, ...entryArgs.value],
    entry: input.entry,
  });
}

function toEntryArgs(
  entry: ClaudeChannelEntry,
  serverName: string,
): Result<readonly string[], Extract<ClaudeChannelLaunchPlanError, { readonly _tag: "InvalidPluginReference" | "InvalidServerName" | "McpConfigInvalid" }>> {
  switch (entry._tag) {
    case "DevelopmentServer":
      if (!isValidEntryName(entry.serverName)) {
        return err({ _tag: "InvalidServerName", value: entry.serverName });
      }
      if (entry.serverName !== serverName) {
        return err({
          _tag: "McpConfigInvalid",
          reason: `development entry server name ${entry.serverName} must match MCP server ${serverName}`,
        });
      }
      return ok([
        "--dangerously-load-development-channels",
        `server:${entry.serverName}`,
      ]);
    case "ApprovedPlugin": {
      const pluginRef = `${entry.pluginName}@${entry.marketplace}`;
      if (!isValidEntryName(entry.pluginName) || !isValidEntryName(entry.marketplace)) {
        return err({ _tag: "InvalidPluginReference", value: pluginRef });
      }
      return ok(["--channels", `plugin:${pluginRef}`]);
    }
    default:
      return absurd(entry);
  }
}

function isValidEntryName(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function absurd(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
