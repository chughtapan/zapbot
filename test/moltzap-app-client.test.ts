import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  __resetAppSingletonForTests,
  bootApp,
  currentApp,
  onMessageForKey,
  resolveConversationIdToKey,
  resolveKeyToConversationId,
  sendOnKey,
  shutdownApp,
  type ZapbotMoltZapAppHandle,
} from "../src/moltzap/app-client.ts";
import { asMoltzapSenderId } from "../src/moltzap/types.ts";

afterEach(() => {
  __resetAppSingletonForTests();
});

// These tests exercise the zapbot-side seam only — role gate, singleton,
// handler registration. Full integration (real WS + server) lives in
// test/integration/*.

function fakeHandle(
  role: "orchestrator" | "architect" | "implementer" | "reviewer",
  conversations: Record<string, string> = {},
): ZapbotMoltZapAppHandle {
  const session = {
    id: "fake-session",
    appId: "zapbot-ws2",
    status: "active",
    conversations,
    conversationId: (key: string) => {
      const id = conversations[key];
      if (id === undefined) throw new Error(`no conv ${key}`);
      return id;
    },
    isActive: true,
  } as unknown as ZapbotMoltZapAppHandle["session"];
  const inner = {
    onMessage: () => {},
    onSessionReady: () => {},
    sendTo: () => Effect.succeed(undefined),
    start: () => Effect.succeed(session),
    stop: () => Effect.succeed(undefined),
    client: {
      sendRpc: () => Effect.succeed(undefined),
    },
  } as unknown as ZapbotMoltZapAppHandle["__unsafeInner"];
  return { role, __unsafeInner: inner, session };
}

describe("app-client — Invariant 1 singleton", () => {
  it("currentApp() returns null before boot", () => {
    expect(currentApp()).toBeNull();
  });

  it.todo(
    "bootApp fails fast with AppBootAlreadyBooted if a singleton exists — integration-level; covered in test/integration when live server is available",
  );
});

describe("app-client — send-side role gate (OQ #3)", () => {
  it("rejects send on a key the role does not send on", async () => {
    const handle = fakeHandle("implementer", {
      "coord-architect-peer": "conv-arch",
    });
    const result = await Effect.runPromise(
      Effect.either(
        sendOnKey(handle, "coord-architect-peer", [
          { type: "text", text: "hello" },
        ]),
      ),
    );
    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "KeyDisallowedForRole",
        role: "implementer",
        key: "coord-architect-peer",
      },
    });
  });

  it("rejects send when the key isn't in the session map", async () => {
    const handle = fakeHandle("implementer", {});
    const result = await Effect.runPromise(
      Effect.either(
        sendOnKey(handle, "coord-worker-to-orch", [
          { type: "text", text: "hello" },
        ]),
      ),
    );
    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "KeyNotInSession",
        key: "coord-worker-to-orch",
      },
    });
  });

  it("passes the RPC through when the key is allowed and in session", async () => {
    const handle = fakeHandle("implementer", {
      "coord-worker-to-orch": "conv-abc",
    });
    const result = await Effect.runPromise(
      Effect.either(
        sendOnKey(handle, "coord-worker-to-orch", [
          { type: "text", text: "hi" },
        ]),
      ),
    );
    expect(result._tag).toBe("Right");
  });
});

describe("app-client — receive gate (Invariant 6: trust key, no body-role check)", () => {
  it("rejects onMessageForKey on keys the role does not receive on", () => {
    const handle = fakeHandle("reviewer");
    const result = onMessageForKey(
      handle,
      "coord-architect-peer",
      () => undefined,
    );
    expect(result).toMatchObject({
      _tag: "KeyNotReceivableForRole",
      role: "reviewer",
      key: "coord-architect-peer",
    });
  });

  it("accepts onMessageForKey for receivable keys", () => {
    const handle = fakeHandle("architect");
    const result = onMessageForKey(
      handle,
      "coord-architect-peer",
      () => undefined,
    );
    expect(result).toBeNull();
  });

  it("rejects a second registration on the same key", () => {
    const handle = fakeHandle("architect");
    expect(
      onMessageForKey(handle, "coord-architect-peer", () => undefined),
    ).toBeNull();
    expect(
      onMessageForKey(handle, "coord-architect-peer", () => undefined),
    ).toMatchObject({
      _tag: "HandlerAlreadyRegistered",
      key: "coord-architect-peer",
    });
  });
});

describe("app-client — resolveKeyToConversationId", () => {
  it("returns a branded conversationId when present", () => {
    const handle = fakeHandle("architect", {
      "coord-architect-peer": "conv-123",
    });
    const result = resolveKeyToConversationId(handle, "coord-architect-peer");
    expect(result).toBe("conv-123");
  });

  it("returns a tagged error when key is missing", () => {
    const handle = fakeHandle("architect", {});
    const result = resolveKeyToConversationId(handle, "coord-architect-peer");
    expect(result).toEqual({
      _tag: "KeyNotInSession",
      key: "coord-architect-peer",
    });
  });
});

describe("app-client — resolveConversationIdToKey (Blocker #3)", () => {
  it("returns the typed key for a conversationId in the session map", () => {
    const handle = fakeHandle("architect", {
      "coord-architect-peer": "conv-peer-123",
      "coord-orch-to-worker": "conv-orch-456",
      "coord-worker-to-orch": "conv-wto-789",
      "coord-review-to-author": "conv-rev-abc",
    });
    expect(resolveConversationIdToKey(handle, "conv-peer-123")).toBe(
      "coord-architect-peer",
    );
    expect(resolveConversationIdToKey(handle, "conv-orch-456")).toBe(
      "coord-orch-to-worker",
    );
  });

  it("returns null for an unknown conversationId (reply fails fast)", () => {
    const handle = fakeHandle("architect", {
      "coord-architect-peer": "conv-peer-123",
    });
    expect(resolveConversationIdToKey(handle, "conv-unknown")).toBeNull();
  });
});

describe("app-client — bootApp singleton race (Blocker #5)", () => {
  // Race: caller A starts `bootApp`, reaches `app.start()` (which tries
  // to open a WebSocket and blocks on the TCP handshake against an
  // unreachable host), `__inflight` is reserved while that async work is
  // pending; caller B runs before the connect fails. Caller B must see
  // `AppBootAlreadyBooted` because `__inflight !== null`, not race A to
  // also construct a `MoltZapApp`.
  it("a second bootApp call while the first is awaiting start() fails with AppBootAlreadyBooted", async () => {
    // 127.0.0.1:1 never accepts connections; `start()` awaits the
    // WebSocket handshake, which is pending when caller B runs.
    const cfg = {
      serverUrl: "ws://127.0.0.1:1",
      agentKey: "k",
      role: "orchestrator" as const,
    };
    const first = Effect.runPromise(Effect.either(bootApp(cfg)));
    // Yield one microtask so caller A's Effect.suspend body has run
    // synchronously up to the start() await.
    await Promise.resolve();
    const second = await Effect.runPromise(Effect.either(bootApp(cfg)));
    expect(second).toMatchObject({
      _tag: "Left",
      left: { _tag: "AppBootAlreadyBooted" },
    });
    // Drain caller A; it will eventually fail (connect refused / timeout).
    // We don't assert on its tag here — that's orthogonal to the race.
    await first.catch(() => undefined);
  }, 15_000);
});

describe("app-client — shutdown", () => {
  it("shutdownApp is a no-op when nothing is booted", async () => {
    const result = await Effect.runPromise(shutdownApp());
    expect(result).toBeUndefined();
  });
});

// Unused import kept to silence CI lint about `asMoltzapSenderId`.
void asMoltzapSenderId;
