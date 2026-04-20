import { describe, expect, it } from "vitest";
import {
  toClaudeChannelNotification,
  toClaudePermissionNotification,
} from "../v2/claude-channel/event.ts";
import {
  asMoltzapConversationId,
  asMoltzapMessageId,
  asMoltzapSenderId,
  type MoltzapInbound,
} from "../v2/moltzap/types.ts";

function makeInbound(overrides: Partial<MoltzapInbound> = {}): MoltzapInbound {
  return {
    messageId: asMoltzapMessageId("msg-1"),
    conversationId: asMoltzapConversationId("conv-1"),
    senderId: asMoltzapSenderId("agent-1"),
    bodyText: "hello from moltzap",
    receivedAtMs: 1_234,
    ...overrides,
  };
}

describe("toClaudeChannelNotification", () => {
  it("maps a MoltZap inbound message into the official Claude channel notification shape", () => {
    const result = toClaudeChannelNotification(makeInbound());
    expect(result).toEqual({
      _tag: "Ok",
      value: {
        method: "notifications/claude/channel",
        params: {
          content: "hello from moltzap",
          meta: {
            conversation_id: "conv-1",
            sender_id: "agent-1",
            message_id: "msg-1",
            received_at_ms: "1234",
          },
        },
      },
    });
  });

  it("rejects blank content", () => {
    const result = toClaudeChannelNotification(makeInbound({ bodyText: "   " }));
    expect(result).toEqual({ _tag: "Err", error: { _tag: "ContentEmpty" } });
  });

  it("rejects invalid metadata", () => {
    const result = toClaudeChannelNotification(
      makeInbound({ senderId: asMoltzapSenderId(""), receivedAtMs: Number.NaN }),
    );
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("MetaInvalid");
  });
});

describe("toClaudePermissionNotification", () => {
  it("maps a permission verdict into the Claude permission notification shape", () => {
    const result = toClaudePermissionNotification({
      requestId: "req-1",
      behavior: "allow",
    });
    expect(result).toEqual({
      _tag: "Ok",
      value: {
        method: "notifications/claude/channel/permission",
        params: {
          request_id: "req-1",
          behavior: "allow",
        },
      },
    });
  });

  it("rejects blank permission request ids", () => {
    const result = toClaudePermissionNotification({
      requestId: "   ",
      behavior: "deny",
    });
    expect(result).toEqual({
      _tag: "Err",
      error: { _tag: "PermissionRequestIdInvalid", value: "   " },
    });
  });
});
