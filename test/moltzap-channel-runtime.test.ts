import { describe, expect, it } from "vitest";
import { bootSessionChannelRuntime } from "../src/moltzap/channel-runtime.ts";
import { ok, err } from "../src/types.ts";
import type { SessionClientHandle } from "../src/moltzap/session-client.ts";
import type {
  ListenerHandle,
  MoltzapInbound,
  MoltzapSdkContext,
  MoltzapSdkHandle,
} from "../src/moltzap/types.ts";
import {
  asMoltzapConversationId,
  asMoltzapMessageId,
  asMoltzapSenderId,
} from "../src/moltzap/types.ts";

const sdk = { __brand: "MoltzapSdkHandle" } as MoltzapSdkHandle;
const sdkContext = { __brand: "MoltzapSdkContext" } as MoltzapSdkContext;
const listenerHandle = { __brand: "ListenerHandle" } as ListenerHandle;

function makeClient(): SessionClientHandle {
  return {
    role: "worker",
    normalizedServerUrl: "ws://127.0.0.1:41973",
    sdk,
    localSenderId: asMoltzapSenderId("worker-1"),
    orchestratorSenderId: asMoltzapSenderId("orch-1"),
    close: async () => ok(undefined),
  };
}

function makeInbound(): MoltzapInbound {
  return {
    messageId: asMoltzapMessageId("msg-1"),
    conversationId: asMoltzapConversationId("conv-1"),
    senderId: asMoltzapSenderId("orch-1"),
    bodyText: "hello",
    receivedAtMs: 123,
  };
}

describe("bootSessionChannelRuntime", () => {
  it("boots the shared runtime, routes inbound messages, and sends replies once LISTENING", async () => {
    const inbound: MoltzapInbound[] = [];
    const outbound: Array<{ conversationId: string; text: string }> = [];
    let registeredCallback: ((event: unknown) => void) | null = null;

    const runtime = await bootSessionChannelRuntime(makeClient(), {
      sdkContext,
      registrar: async (_sdk, cb) => {
        registeredCallback = cb;
        return ok(listenerHandle);
      },
      sender: async (_ctx, args) => {
        outbound.push({
          conversationId: args.conversationId,
          text: args.text,
        });
        return ok(undefined);
      },
      onInbound: async (event) => {
        inbound.push(event);
        return ok(undefined);
      },
      decodeDiag: () => {},
      bridgeDiag: () => {},
      now: () => 77,
    });

    expect(runtime._tag).toBe("Ok");
    if (runtime._tag !== "Ok") return;
    expect(runtime.value.state._tag).toBe("LISTENING");

    registeredCallback?.(makeInbound());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inbound).toHaveLength(1);

    const send = await runtime.value.send({
      conversationId: asMoltzapConversationId("conv-1"),
      text: "ack",
    });
    expect(send).toEqual({
      _tag: "Ok",
      value: { _tag: "Sent", at: 77 },
    });
    expect(outbound).toEqual([{ conversationId: "conv-1", text: "ack" }]);
  });

  it("moves to FAILED if inbound routing rejects", async () => {
    let registeredCallback: ((event: unknown) => void) | null = null;
    const runtime = await bootSessionChannelRuntime(makeClient(), {
      sdkContext,
      registrar: async (_sdk, cb) => {
        registeredCallback = cb;
        return ok(listenerHandle);
      },
      sender: async () => ok(undefined),
      onInbound: async () => err({ _tag: "InboundRouteFailed", cause: "router rejected" }),
      decodeDiag: () => {},
      bridgeDiag: () => {},
    });
    expect(runtime._tag).toBe("Ok");
    if (runtime._tag !== "Ok") return;

    registeredCallback?.(makeInbound());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.value.state._tag).toBe("FAILED");
  });
});
