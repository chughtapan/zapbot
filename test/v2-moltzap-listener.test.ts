import { describe, it, expect } from "vitest";
import {
  register,
  type MoltzapRegistrar,
  type DecodeError,
} from "../v2/moltzap/listener.ts";
import {
  INITIAL,
  transition,
  type LifecycleEvent,
  type LifecycleState,
} from "../v2/moltzap/lifecycle.ts";
import type { ListenerHandle, MoltzapInbound, MoltzapSdkHandle } from "../v2/moltzap/types.ts";
import { ok, err } from "../v2/types.ts";

const sdk = { __brand: "MoltzapSdkHandle" } as MoltzapSdkHandle;
const handle = { __brand: "ListenerHandle" } as ListenerHandle;
const noopCb = (_event: MoltzapInbound) => {};
const noopDiag = (_error: DecodeError) => {};

function driveTo(ev: LifecycleEvent[]): LifecycleState {
  let s: LifecycleState = INITIAL;
  for (const e of ev) {
    const r = transition(s, e);
    if (r._tag !== "Next") throw new Error(`setup broke at ${e._tag}`);
    s = r.state;
  }
  return s;
}

const READY_PATH: LifecycleEvent[] = [
  { _tag: "StdioConnectStarted" },
  { _tag: "StdioConnected" },
  { _tag: "MoltzapConnectStarted" },
  { _tag: "MoltzapReady" },
];

const validRaw: unknown = {
  messageId: "msg-abc",
  conversationId: "conv-xyz",
  senderId: "user-1",
  bodyText: "hello world",
  receivedAtMs: 1_700_000_000_000,
};

describe("listener.register — pre-ready rejection", () => {
  it("INIT → NotReady (sub-issue AC1.1 / Q2 option (a): forbid pre-ready attach)", async () => {
    const registrar: MoltzapRegistrar = async () => {
      throw new Error("registrar must not be called pre-ready");
    };
    const result = await register(INITIAL, sdk, noopCb, registrar, noopDiag);
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("NotReady");
  });

  it("STDIO_READY → NotReady", async () => {
    const s = driveTo([{ _tag: "StdioConnectStarted" }, { _tag: "StdioConnected" }]);
    let called = false;
    const registrar: MoltzapRegistrar = async () => {
      called = true;
      return ok(handle);
    };
    const result = await register(s, sdk, noopCb, registrar, noopDiag);
    expect(result._tag).toBe("Err");
    expect(called).toBe(false);
  });

  it("MOLTZAP_CONNECTING → NotReady", async () => {
    const s = driveTo([
      { _tag: "StdioConnectStarted" },
      { _tag: "StdioConnected" },
      { _tag: "MoltzapConnectStarted" },
    ]);
    const registrar: MoltzapRegistrar = async () => ok(handle);
    const result = await register(s, sdk, noopCb, registrar, noopDiag);
    expect(result._tag).toBe("Err");
  });
});

describe("listener.register — happy path", () => {
  it("MOLTZAP_READY → Ok(handle), registrar called exactly once", async () => {
    const state = driveTo(READY_PATH);
    let calls = 0;
    const registrar: MoltzapRegistrar = async () => {
      calls += 1;
      return ok(handle);
    };
    const result = await register(state, sdk, noopCb, registrar, noopDiag);
    expect(result._tag).toBe("Ok");
    expect(calls).toBe(1);
  });
});

describe("listener.register — SDK rejection", () => {
  it("registrar returns Err → Err(SDKRejected)", async () => {
    const state = driveTo(READY_PATH);
    const registrar: MoltzapRegistrar = async () =>
      err({ _tag: "SDKRejected", cause: "SDK timed out during onMessage wiring" });
    const result = await register(state, sdk, noopCb, registrar, noopDiag);
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("SDKRejected");
  });

  it("registrar throws → Err(SDKRejected) with thrown cause", async () => {
    const state = driveTo(READY_PATH);
    const boom = new Error("duplicate listener wiring");
    const registrar: MoltzapRegistrar = async () => {
      throw boom;
    };
    const result = await register(state, sdk, noopCb, registrar, noopDiag);
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("SDKRejected");
    if (result.error._tag !== "SDKRejected") return;
    expect(result.error.cause).toBe(boom);
  });
});

describe("listener.register — re-registration guard", () => {
  it("LISTENING → NotReady (one process, one listener)", async () => {
    const listening: LifecycleState = {
      _tag: "LISTENING",
      listener: handle,
    };
    const registrar: MoltzapRegistrar = async () => ok(handle);
    const result = await register(listening, sdk, noopCb, registrar, noopDiag);
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("NotReady");
  });
});

// ── Decode layer tests ───────────────────────────────────────────────
//
// The registrar now receives cb: (event: unknown) => void. These tests
// drive that wrapped callback directly to verify the decode layer
// independent of SDK wiring.

describe("listener.register — decode layer (valid event)", () => {
  it("well-formed raw event → decoded and forwarded to user callback", async () => {
    const state = driveTo(READY_PATH);
    const received: MoltzapInbound[] = [];
    const diagCalls: DecodeError[] = [];
    const registrar: MoltzapRegistrar = async (_sdk, cb) => {
      cb(validRaw);
      return ok(handle);
    };
    await register(state, sdk, (e) => received.push(e), registrar, (d) => diagCalls.push(d));
    expect(received).toHaveLength(1);
    expect(received[0].messageId).toBe("msg-abc");
    expect(received[0].conversationId).toBe("conv-xyz");
    expect(received[0].senderId).toBe("user-1");
    expect(received[0].bodyText).toBe("hello world");
    expect(received[0].receivedAtMs).toBe(1_700_000_000_000);
    expect(diagCalls).toHaveLength(0);
  });

  it("extra unknown fields in raw event are ignored (forward-compat)", async () => {
    const state = driveTo(READY_PATH);
    const received: MoltzapInbound[] = [];
    const withExtras: unknown = { ...validRaw as object, unknownFutureProp: true, version: 2 };
    const registrar: MoltzapRegistrar = async (_sdk, cb) => {
      cb(withExtras);
      return ok(handle);
    };
    await register(state, sdk, (e) => received.push(e), registrar, noopDiag);
    expect(received).toHaveLength(1);
  });

  it("edge: empty string messageId is valid", async () => {
    const state = driveTo(READY_PATH);
    const received: MoltzapInbound[] = [];
    const raw: unknown = { ...validRaw as object, messageId: "" };
    const registrar: MoltzapRegistrar = async (_sdk, cb) => {
      cb(raw);
      return ok(handle);
    };
    await register(state, sdk, (e) => received.push(e), registrar, noopDiag);
    expect(received).toHaveLength(1);
    expect(received[0].messageId).toBe("");
  });

  it("edge: receivedAtMs = 0 is valid", async () => {
    const state = driveTo(READY_PATH);
    const received: MoltzapInbound[] = [];
    const raw: unknown = { ...validRaw as object, receivedAtMs: 0 };
    const registrar: MoltzapRegistrar = async (_sdk, cb) => {
      cb(raw);
      return ok(handle);
    };
    await register(state, sdk, (e) => received.push(e), registrar, noopDiag);
    expect(received).toHaveLength(1);
    expect(received[0].receivedAtMs).toBe(0);
  });
});

describe("listener.register — decode layer (invalid events)", () => {
  it("null input → DecodeError on '.', event dropped", async () => {
    const state = driveTo(READY_PATH);
    const received: MoltzapInbound[] = [];
    const diagCalls: DecodeError[] = [];
    const registrar: MoltzapRegistrar = async (_sdk, cb) => {
      cb(null);
      return ok(handle);
    };
    await register(state, sdk, (e) => received.push(e), registrar, (d) => diagCalls.push(d));
    expect(received).toHaveLength(0);
    expect(diagCalls).toHaveLength(1);
    expect(diagCalls[0]._tag).toBe("DecodeError");
    expect(diagCalls[0].field).toBe(".");
  });

  it("missing messageId → DecodeError on 'messageId', event dropped", async () => {
    const state = driveTo(READY_PATH);
    const received: MoltzapInbound[] = [];
    const diagCalls: DecodeError[] = [];
    const { messageId: _omit, ...withoutId } = validRaw as Record<string, unknown>;
    const registrar: MoltzapRegistrar = async (_sdk, cb) => {
      cb(withoutId);
      return ok(handle);
    };
    await register(state, sdk, (e) => received.push(e), registrar, (d) => diagCalls.push(d));
    expect(received).toHaveLength(0);
    expect(diagCalls[0].field).toBe("messageId");
  });

  it("wrong type on receivedAtMs (string) → DecodeError on 'receivedAtMs'", async () => {
    const state = driveTo(READY_PATH);
    const diagCalls: DecodeError[] = [];
    const raw: unknown = { ...validRaw as object, receivedAtMs: "not-a-number" };
    const registrar: MoltzapRegistrar = async (_sdk, cb) => {
      cb(raw);
      return ok(handle);
    };
    await register(state, sdk, noopCb, registrar, (d) => diagCalls.push(d));
    expect(diagCalls).toHaveLength(1);
    expect(diagCalls[0].field).toBe("receivedAtMs");
    expect(diagCalls[0].raw).toBe("not-a-number");
  });

  it("array input (non-object) → DecodeError on '.'", async () => {
    const state = driveTo(READY_PATH);
    const diagCalls: DecodeError[] = [];
    const registrar: MoltzapRegistrar = async (_sdk, cb) => {
      cb(["not", "an", "object"]);
      return ok(handle);
    };
    await register(state, sdk, noopCb, registrar, (d) => diagCalls.push(d));
    expect(diagCalls).toHaveLength(1);
    expect(diagCalls[0].field).toBe(".");
  });

  it("multiple events: valid then invalid → forward then drop", async () => {
    const state = driveTo(READY_PATH);
    const received: MoltzapInbound[] = [];
    const diagCalls: DecodeError[] = [];
    const registrar: MoltzapRegistrar = async (_sdk, cb) => {
      cb(validRaw);
      cb({ ...validRaw as object, bodyText: 42 });
      return ok(handle);
    };
    await register(state, sdk, (e) => received.push(e), registrar, (d) => diagCalls.push(d));
    expect(received).toHaveLength(1);
    expect(diagCalls).toHaveLength(1);
    expect(diagCalls[0].field).toBe("bodyText");
  });
});
