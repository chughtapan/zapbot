import { describe, expect, it } from "vitest";
import {
  makeMcpForwardHandler,
  toClaudeNotification,
  wireMcpAdapter,
  type McpAdapterContext,
} from "../src/moltzap/mcp-adapter.ts";
import {
  asMoltzapSenderId,
} from "../src/moltzap/types.ts";
import { ok, err } from "../src/types.ts";

function fakeCtx(): {
  readonly ctx: McpAdapterContext;
  readonly pushed: unknown[];
} {
  const pushed: unknown[] = [];
  const ctx: McpAdapterContext = {
    channel: {
      push: async (n) => {
        pushed.push(n);
        return ok(undefined);
      },
      pushPermissionVerdict: async () => ok(undefined),
      stop: async () => ok(undefined),
    },
    localSenderId: asMoltzapSenderId("local-agent"),
    orchestratorSenderId: asMoltzapSenderId("orch-agent"),
  };
  return { ctx, pushed };
}

describe("mcp-adapter — toClaudeNotification", () => {
  const { ctx } = fakeCtx();

  it("flattens text parts into the content field", () => {
    const result = toClaudeNotification(
      "coord-orch-to-worker",
      {
        id: "m1",
        conversationId: "c1",
        senderId: "s1",
        parts: [
          { type: "text", text: "hello" },
          { type: "text", text: "world" },
        ],
        createdAt: "2026-04-24T00:00:00Z",
      },
      ctx,
    );
    expect(result).toMatchObject({
      method: "notifications/claude/channel",
      params: {
        content: "hello\nworld",
        meta: {
          conversation_id: "c1",
          sender_id: "s1",
          message_id: "m1",
        },
      },
    });
  });

  it("returns UnknownMessageShape when parts is empty", () => {
    const result = toClaudeNotification(
      "coord-orch-to-worker",
      {
        id: "m1",
        conversationId: "c1",
        senderId: "s1",
        parts: [],
        createdAt: "2026-04-24T00:00:00Z",
      },
      ctx,
    );
    expect(result).toMatchObject({
      _tag: "UnknownMessageShape",
    });
  });

  it("returns UnknownMessageShape when required fields are missing", () => {
    const result = toClaudeNotification(
      "coord-orch-to-worker",
      {
        id: null,
        conversationId: null,
        senderId: null,
        parts: [{ type: "text", text: "hi" }],
      } as unknown as Parameters<typeof toClaudeNotification>[1],
      ctx,
    );
    expect(result).toMatchObject({
      _tag: "UnknownMessageShape",
    });
  });
});

describe("mcp-adapter — makeMcpForwardHandler", () => {
  it("pushes a notification through the channel on valid messages", async () => {
    const { ctx, pushed } = fakeCtx();
    const handler = makeMcpForwardHandler("coord-orch-to-worker", ctx);
    await handler({
      id: "m2",
      conversationId: "c2",
      senderId: "s2",
      parts: [{ type: "text", text: "ok" }],
      createdAt: "2026-04-24T00:00:00Z",
    } as Parameters<typeof handler>[0]);
    expect(pushed).toHaveLength(1);
  });

  it("drops malformed messages without pushing", async () => {
    const { ctx, pushed } = fakeCtx();
    const handler = makeMcpForwardHandler("coord-orch-to-worker", ctx);
    await handler({
      id: "m3",
      conversationId: "c3",
      senderId: "s3",
      parts: [],
      createdAt: "2026-04-24T00:00:00Z",
    } as Parameters<typeof handler>[0]);
    expect(pushed).toHaveLength(0);
  });

  it("logs but does not throw when channel.push fails", async () => {
    const { pushed } = fakeCtx();
    const ctx: McpAdapterContext = {
      channel: {
        push: async () => err({ _tag: "PushFailed" as const, cause: "offline" }),
        pushPermissionVerdict: async () => ok(undefined),
        stop: async () => ok(undefined),
      },
      localSenderId: asMoltzapSenderId("local-agent"),
      orchestratorSenderId: null,
    };
    const handler = makeMcpForwardHandler("coord-worker-to-orch", ctx);
    // Expect the handler to resolve (not reject) even though push failed.
    let caught: unknown = null;
    try {
      await handler({
        id: "m4",
        conversationId: "c4",
        senderId: "s4",
        parts: [{ type: "text", text: "ok" }],
        createdAt: "2026-04-24T00:00:00Z",
      } as Parameters<typeof handler>[0]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeNull();
    // pushed array was never appended because the fake channel errors.
    expect(pushed).toHaveLength(0);
  });
});

describe("mcp-adapter — wireMcpAdapter", () => {
  it("returns the list of receivable keys verbatim", () => {
    const { ctx } = fakeCtx();
    const wired = wireMcpAdapter(ctx, [
      "coord-orch-to-worker",
      "coord-review-to-author",
    ]);
    expect([...wired]).toEqual([
      "coord-orch-to-worker",
      "coord-review-to-author",
    ]);
  });
});
