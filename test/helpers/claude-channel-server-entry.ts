import fs from "node:fs/promises";
import process from "node:process";
import { bootClaudeChannelServer } from "../../v2/claude-channel/server.ts";
import { ok } from "../../v2/types.ts";
import {
  asMoltzapConversationId,
  asMoltzapMessageId,
  asMoltzapSenderId,
} from "../../v2/moltzap/types.ts";

const replyFile = process.env.CLAUDE_CHANNEL_REPLY_FILE ?? "";
const permissionFile = process.env.CLAUDE_CHANNEL_PERMISSION_FILE ?? "";
const pushOnStart = process.env.CLAUDE_CHANNEL_PUSH_ON_START === "1";
const permissionVerdict = process.env.CLAUDE_CHANNEL_PERMISSION_VERDICT;

const booted = await bootClaudeChannelServer(
  {
    serverName: "moltzap",
    instructions: "Test Claude channel server",
    enableReplyTool: true,
    enablePermissionRelay: permissionFile.length > 0,
  },
  {
    sendReply: async (args) => {
      await fs.appendFile(replyFile, `${JSON.stringify(args)}\n`, "utf8");
      return ok(undefined);
    },
    forwardPermissionRequest:
      permissionFile.length > 0
        ? async (request) => {
            await fs.appendFile(permissionFile, `${JSON.stringify(request)}\n`, "utf8");
            return ok(undefined);
          }
        : undefined,
  },
);

if (booted._tag === "Err") {
  console.error(JSON.stringify(booted.error));
  process.exit(1);
}

if (pushOnStart) {
  setTimeout(() => {
    void booted.value.push({
      method: "notifications/claude/channel",
      params: {
        content: "hello from spawned channel server",
        meta: {
          conversation_id: asMoltzapConversationId("conv-spawned"),
          sender_id: asMoltzapSenderId("orch-1"),
          message_id: asMoltzapMessageId("msg-spawned"),
          received_at_ms: "1234",
        },
      },
    });
  }, 150);
}

if (permissionVerdict === "allow" || permissionVerdict === "deny") {
  setTimeout(() => {
    void booted.value.pushPermissionVerdict({
      method: "notifications/claude/channel/permission",
      params: {
        request_id: "req-spawned",
        behavior: permissionVerdict,
      },
    });
  }, 250);
}

const keepAlive = setInterval(() => {}, 1_000);

async function stopAndExit(): Promise<void> {
  clearInterval(keepAlive);
  await booted.value.stop();
  process.exit(0);
}

process.on("SIGTERM", () => {
  void stopAndExit();
});
