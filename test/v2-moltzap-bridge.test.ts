import { describe, it, expect } from "vitest";
import {
  onInbound,
  reply,
  type BridgeError,
  type ChannelNotification,
  type McpNotifier,
  type MoltzapSender,
} from "../v2/moltzap/bridge.ts";
import { INITIAL, type LifecycleState } from "../v2/moltzap/lifecycle.ts";
import {
  asMoltzapConversationId,
  asMoltzapMessageId,
  asMoltzapSenderId,
  type ListenerHandle,
  type McpContext,
  type MoltzapInbound,
  type MoltzapSdkContext,
} from "../v2/moltzap/types.ts";
import { err, ok } from "../v2/types.ts";

const mcpCtx = { __brand: "McpContext" } as McpContext;
const sdkCtx = { __brand: "MoltzapSdkContext" } as MoltzapSdkContext;
const handle = { __brand: "ListenerHandle" } as ListenerHandle;

const LISTENING: LifecycleState = { _tag: "LISTENING", listener: handle };

function makeEvent(): MoltzapInbound {
  return {
    messageId: asMoltzapMessageId("m-1"),
    conversationId: asMoltzapConversationId("conv-A"),
    senderId: asMoltzapSenderId("user-42"),
    bodyText: "hello from moltzap",
    receivedAtMs: 1_000_000,
  };
}

describe("bridge.onInbound — LISTENING gate", () => {
  it("routes the event to MCP notify when LISTENING", async () => {
    const sent: ChannelNotification[] = [];
    const notify: McpNotifier = async (_ctx, n) => {
      sent.push(n);
      return ok(undefined);
    };
    const dropped: BridgeError[] = [];
    const diag = (e: BridgeError) => dropped.push(e);

    const result = await onInbound(LISTENING, makeEvent(), mcpCtx, notify, diag);
    expect(result._tag).toBe("Ok");
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe("notifications/claude/channel");
    expect(sent[0].params.channelTag).toBe("moltzap");
    expect(sent[0].params.body).toBe("hello from moltzap");
    expect(dropped).toHaveLength(0);
  });

  it("drops the event with PreReadyEventDropped when state is INIT", async () => {
    let notifyCalled = false;
    const notify: McpNotifier = async () => {
      notifyCalled = true;
      return ok(undefined);
    };
    const dropped: BridgeError[] = [];
    const diag = (e: BridgeError) => dropped.push(e);

    const result = await onInbound(INITIAL, makeEvent(), mcpCtx, notify, diag);
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("PreReadyEventDropped");
    expect(notifyCalled).toBe(false);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]._tag).toBe("PreReadyEventDropped");
  });

  it("surfaces OutboundFailed when notify fails", async () => {
    const notify: McpNotifier = async () => err({ cause: "MCP stdio broken" });
    const result = await onInbound(LISTENING, makeEvent(), mcpCtx, notify, () => {});
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("OutboundFailed");
  });

  it("surfaces OutboundFailed when notify throws", async () => {
    const boom = new Error("transport already closed");
    const notify: McpNotifier = async () => {
      throw boom;
    };
    const result = await onInbound(LISTENING, makeEvent(), mcpCtx, notify, () => {});
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("OutboundFailed");
    if (result.error._tag !== "OutboundFailed") return;
    expect(result.error.cause).toBe(boom);
  });
});

describe("bridge.reply — LISTENING gate", () => {
  it("sends via moltzap sender and returns a receipt when LISTENING", async () => {
    const sent: { conversationId: string; text: string }[] = [];
    const sender: MoltzapSender = async (_ctx, args) => {
      sent.push({ conversationId: args.conversationId, text: args.text });
      return ok(undefined);
    };
    const result = await reply(
      LISTENING,
      { conversationId: asMoltzapConversationId("conv-A"), text: "ack" },
      sdkCtx,
      sender,
      () => 7_000_000,
    );
    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok") return;
    expect(result.value._tag).toBe("Sent");
    expect(result.value.at).toBe(7_000_000);
    expect(sent).toEqual([{ conversationId: "conv-A", text: "ack" }]);
  });

  it("refuses with NotListening when state is INIT", async () => {
    let senderCalled = false;
    const sender: MoltzapSender = async () => {
      senderCalled = true;
      return ok(undefined);
    };
    const result = await reply(
      INITIAL,
      { conversationId: asMoltzapConversationId("conv-A"), text: "ack" },
      sdkCtx,
      sender,
    );
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("NotListening");
    expect(senderCalled).toBe(false);
  });

  it("refuses with NotListening when state is FAILED", async () => {
    const failed: LifecycleState = {
      _tag: "FAILED",
      cause: { _tag: "MoltzapHandshakeError", cause: "timeout" },
    };
    const sender: MoltzapSender = async () => ok(undefined);
    const result = await reply(
      failed,
      { conversationId: asMoltzapConversationId("conv-A"), text: "ack" },
      sdkCtx,
      sender,
    );
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("NotListening");
  });

  it("surfaces OutboundFailed when sender fails", async () => {
    const sender: MoltzapSender = async () => err({ cause: "websocket closed" });
    const result = await reply(
      LISTENING,
      { conversationId: asMoltzapConversationId("conv-A"), text: "ack" },
      sdkCtx,
      sender,
    );
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("OutboundFailed");
  });

  it("surfaces OutboundFailed when sender throws", async () => {
    const boom = new Error("socket closed mid-send");
    const sender: MoltzapSender = async () => {
      throw boom;
    };
    const result = await reply(
      LISTENING,
      { conversationId: asMoltzapConversationId("conv-A"), text: "ack" },
      sdkCtx,
      sender,
    );
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("OutboundFailed");
    if (result.error._tag !== "OutboundFailed") return;
    expect(result.error.cause).toBe(boom);
  });
});

describe("bridge.onInbound — order preserved (I2)", () => {
  it("two inbound events arrive at MCP in delivery order", async () => {
    const order: string[] = [];
    const notify: McpNotifier = async (_ctx, n) => {
      order.push(n.params.messageId);
      return ok(undefined);
    };
    const first: MoltzapInbound = { ...makeEvent(), messageId: asMoltzapMessageId("m-1") };
    const second: MoltzapInbound = { ...makeEvent(), messageId: asMoltzapMessageId("m-2") };
    await onInbound(LISTENING, first, mcpCtx, notify, () => {});
    await onInbound(LISTENING, second, mcpCtx, notify, () => {});
    expect(order).toEqual(["m-1", "m-2"]);
  });
});
