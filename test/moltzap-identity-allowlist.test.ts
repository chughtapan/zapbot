import { describe, expect, it } from "vitest";
import {
  fromSenderIds,
  gateInbound,
} from "../src/moltzap/identity-allowlist.ts";
import {
  asMoltzapConversationId,
  asMoltzapMessageId,
  asMoltzapSenderId,
  type MoltzapInbound,
} from "../src/moltzap/types.ts";

function makeEvent(senderId: string): MoltzapInbound {
  return {
    messageId: asMoltzapMessageId("msg-1"),
    conversationId: asMoltzapConversationId("conv-1"),
    senderId: asMoltzapSenderId(senderId),
    bodyText: "hello",
    receivedAtMs: 1_700_000_000_000,
  };
}

describe("identity-allowlist", () => {
  it("allows configured sender IDs through unchanged", () => {
    const allowlist = fromSenderIds([asMoltzapSenderId("agent-a")]);
    const event = makeEvent("agent-a");
    const result = gateInbound(allowlist, event);
    expect(result).toEqual({ _tag: "Ok", value: event });
  });

  it("rejects sender IDs outside the allowlist with SenderNotAllowed", () => {
    const allowlist = fromSenderIds([asMoltzapSenderId("agent-a")]);
    const event = makeEvent("agent-b");
    const result = gateInbound(allowlist, event);
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("SenderNotAllowed");
    expect(result.error.senderId).toBe("agent-b");
    expect(result.error.event).toEqual({
      messageId: asMoltzapMessageId("msg-1"),
      conversationId: asMoltzapConversationId("conv-1"),
      senderId: asMoltzapSenderId("agent-b"),
      receivedAtMs: 1_700_000_000_000,
    });
    expect("bodyText" in result.error.event).toBe(false);
  });

  it("empty allowlist rejects all inbound senders", () => {
    const allowlist = fromSenderIds([]);
    const result = gateInbound(allowlist, makeEvent("agent-z"));
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("SenderNotAllowed");
  });
});
