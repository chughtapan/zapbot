import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Notification } from "@modelcontextprotocol/sdk/types.js";

const helperPath = path.join(process.cwd(), "test/helpers/claude-channel-server-entry.ts");
const bunLookup = spawnSync("which", ["bun"], { encoding: "utf8" });
const bunCommand = bunLookup.status === 0 ? bunLookup.stdout.trim() : "bun";

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

afterEach(() => {
  // No-op placeholder so vitest runs the file serially without leaked globals.
});

describe("bootClaudeChannelServer", () => {
  it("serves the reply tool, handles tool calls, and emits Claude channel notifications over stdio", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zapbot-claude-channel-"));
    const replyFile = path.join(tempDir, "reply.log");
    const permissionFile = path.join(tempDir, "permission.log");
    const notifications: Notification[] = [];

    const client = new Client({ name: "zapbot-test-client", version: "1.0.0" });
    client.fallbackNotificationHandler = async (notification) => {
      notifications.push(notification);
    };

    const transport = new StdioClientTransport({
      command: bunCommand,
      args: [helperPath],
      cwd: process.cwd(),
      stderr: "pipe",
      env: {
        ...process.env,
        CLAUDE_CHANNEL_REPLY_FILE: replyFile,
        CLAUDE_CHANNEL_PERMISSION_FILE: permissionFile,
        CLAUDE_CHANNEL_PUSH_ON_START: "1",
        CLAUDE_CHANNEL_PERMISSION_VERDICT: "allow",
      },
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    try {
      await client.connect(transport);

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("reply");

      const replyResult = await client.callTool({
        name: "reply",
        arguments: {
          conversationId: "conv-test",
          text: "reply from client",
        },
      });
      expect(replyResult.isError).not.toBe(true);

      await client.notification({
        method: "notifications/claude/channel/permission_request",
        params: {
          request_id: "req-client",
          tool_name: "bash",
          description: "Run a shell command",
          input_preview: "ls -la",
        },
      } as never);

      await waitFor(() => fs.existsSync(replyFile) && fs.readFileSync(replyFile, "utf8").includes("conv-test"));
      await waitFor(
        () =>
          notifications.some(
            (notification) => notification.method === "notifications/claude/channel",
          ) &&
          notifications.some(
            (notification) =>
              notification.method === "notifications/claude/channel/permission",
          ) &&
          fs.existsSync(permissionFile) &&
          fs.readFileSync(permissionFile, "utf8").includes("req-client"),
      );

      const replyLog = fs.readFileSync(replyFile, "utf8");
      expect(replyLog).toContain("\"conversationId\":\"conv-test\"");
      expect(replyLog).toContain("\"text\":\"reply from client\"");

      const channelNotification = notifications.find(
        (notification) => notification.method === "notifications/claude/channel",
      );
      expect(channelNotification).toBeDefined();
      expect(channelNotification?.params).toMatchObject({
        content: "hello from spawned channel server",
      });

      const permissionNotification = notifications.find(
        (notification) => notification.method === "notifications/claude/channel/permission",
      );
      expect(permissionNotification).toBeDefined();
      expect(permissionNotification?.params).toMatchObject({
        request_id: "req-spawned",
        behavior: "allow",
      });
    } catch (cause) {
      throw new Error(
        `stdio channel test failed: ${String(cause)}${
          stderr.length > 0 ? `\nchild stderr:\n${stderr}` : ""
        }`,
      );
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});
