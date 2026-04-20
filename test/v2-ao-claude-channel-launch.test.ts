import { describe, expect, it } from "vitest";
import {
  planClaudeChannelLaunch,
  renderSessionMcpConfig,
} from "../v2/ao/claude-channel-launch.ts";

const server = {
  name: "moltzap",
  command: "bun",
  args: ["run", "channel-server.ts"],
  env: {
    MOLTZAP_SERVER_URL: "ws://127.0.0.1:41973",
    MOLTZAP_API_KEY: "test-key",
  },
} as const;

describe("renderSessionMcpConfig", () => {
  it("renders a session-local Claude MCP config", () => {
    const result = renderSessionMcpConfig(server);
    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok") return;
    expect(JSON.parse(result.value)).toEqual({
      mcpServers: {
        moltzap: {
          command: "bun",
          args: ["run", "channel-server.ts"],
          env: {
            MOLTZAP_SERVER_URL: "ws://127.0.0.1:41973",
            MOLTZAP_API_KEY: "test-key",
          },
        },
      },
    });
  });

  it("rejects invalid MCP config input", () => {
    const result = renderSessionMcpConfig({
      ...server,
      command: "   ",
    });
    expect(result).toEqual({
      _tag: "Err",
      error: {
        _tag: "McpConfigInvalid",
        reason: "server.command must be a non-empty string",
      },
    });
  });
});

describe("planClaudeChannelLaunch", () => {
  it("plans the development-channel launch path", () => {
    const result = planClaudeChannelLaunch({
      server,
      entry: { _tag: "DevelopmentServer", serverName: "moltzap" },
      mcpConfigPath: "/tmp/session/.mcp.json",
    });
    expect(result).toEqual({
      _tag: "Ok",
      value: {
        mcpConfigPath: "/tmp/session/.mcp.json",
        mcpConfigJson: JSON.stringify(
          {
            mcpServers: {
              moltzap: {
                command: "bun",
                args: ["run", "channel-server.ts"],
                env: {
                  MOLTZAP_SERVER_URL: "ws://127.0.0.1:41973",
                  MOLTZAP_API_KEY: "test-key",
                },
              },
            },
          },
          null,
          2,
        ),
        extraArgs: [
          "--mcp-config",
          "/tmp/session/.mcp.json",
          "--dangerously-load-development-channels",
          "server:moltzap",
        ],
        entry: { _tag: "DevelopmentServer", serverName: "moltzap" },
      },
    });
  });

  it("plans the allowlisted plugin launch path", () => {
    const result = planClaudeChannelLaunch({
      server,
      entry: {
        _tag: "ApprovedPlugin",
        pluginName: "moltzap",
        marketplace: "claude-plugins-official",
      },
      mcpConfigPath: "/tmp/session/.mcp.json",
    });
    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok") return;
    expect(result.value.extraArgs).toEqual([
      "--mcp-config",
      "/tmp/session/.mcp.json",
      "--channels",
      "plugin:moltzap@claude-plugins-official",
    ]);
  });

  it("rejects development entries that do not match the configured MCP server name", () => {
    const result = planClaudeChannelLaunch({
      server,
      entry: { _tag: "DevelopmentServer", serverName: "other" },
      mcpConfigPath: "/tmp/session/.mcp.json",
    });
    expect(result).toEqual({
      _tag: "Err",
      error: {
        _tag: "McpConfigInvalid",
        reason: "development entry server name other must match MCP server moltzap",
      },
    });
  });
});
