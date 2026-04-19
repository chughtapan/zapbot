/**
 * v2/ao/claude-channel-launch — plan the Claude Code launch flags and
 * session-local MCP config needed to activate a MoltZap-backed custom channel.
 *
 * Architect phase only: public surface, no implementation.
 */

import type { Result } from "../types.ts";

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
  throw new Error("not implemented");
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
  throw new Error("not implemented");
}
