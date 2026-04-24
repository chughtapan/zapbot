import { describe, expect, it } from "vitest";
import type { EnrichedInboundMessage } from "@moltzap/client";
import {
  buildSenderAllowlistGate,
  checkSender,
  fromSenderIds,
} from "../src/moltzap/identity-allowlist.ts";
import { asMoltzapSenderId } from "../src/moltzap/types.ts";

function makeEvent(senderId: string): EnrichedInboundMessage {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    sender: { id: senderId, name: senderId },
    text: "hello",
    isFromMe: false,
    createdAt: "2026-04-24T00:00:00.000Z",
    contextBlocks: {},
  };
}

describe("identity-allowlist — checkSender", () => {
  it("allows configured sender IDs through", () => {
    const allowlist = fromSenderIds([asMoltzapSenderId("agent-a")]);
    const result = checkSender(
      allowlist,
      asMoltzapSenderId("agent-a"),
      { conversationId: "conv-1", messageId: "msg-1" },
    );
    expect(result._tag).toBe("Ok");
  });

  it("rejects unknown senders with SenderNotAllowed", () => {
    const allowlist = fromSenderIds([asMoltzapSenderId("agent-a")]);
    const result = checkSender(
      allowlist,
      asMoltzapSenderId("agent-b"),
      { conversationId: "conv-1", messageId: "msg-1" },
    );
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("SenderNotAllowed");
    expect(result.error.senderId).toBe("agent-b");
    expect(result.error.conversationId).toBe("conv-1");
    expect(result.error.messageId).toBe("msg-1");
  });

  it("empty allowlist rejects all", () => {
    const allowlist = fromSenderIds([]);
    const result = checkSender(
      allowlist,
      asMoltzapSenderId("agent-z"),
      { conversationId: "c", messageId: "m" },
    );
    expect(result._tag).toBe("Err");
  });
});

describe("identity-allowlist — buildSenderAllowlistGate (upstream adapter)", () => {
  it("returns Success for allowed senders with the original event", () => {
    const allowlist = fromSenderIds([asMoltzapSenderId("agent-a")]);
    const gate = buildSenderAllowlistGate(allowlist);
    const event = makeEvent("agent-a");
    const result = gate(event);
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") return;
    expect(result.value).toBe(event);
  });

  it("returns Failure.SenderNotAllowed for unknown senders with a diagnostic reason", () => {
    const allowlist = fromSenderIds([asMoltzapSenderId("agent-a")]);
    const gate = buildSenderAllowlistGate(allowlist);
    const result = gate(makeEvent("agent-b"));
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") return;
    expect(result.error._tag).toBe("SenderNotAllowed");
    expect(result.error.senderId).toBe("agent-b");
    expect(result.error.reason).toMatch(/agent-b/);
    expect(result.error.reason).toMatch(/conv-1/);
  });

  it("empty allowlist rejects every inbound", () => {
    const allowlist = fromSenderIds([]);
    const gate = buildSenderAllowlistGate(allowlist);
    const result = gate(makeEvent("any-agent"));
    expect(result._tag).toBe("Failure");
  });
});
