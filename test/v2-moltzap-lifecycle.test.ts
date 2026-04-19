import { describe, it, expect } from "vitest";
import {
  INITIAL,
  transition,
  isListening,
  isMoltzapReady,
  type LifecycleState,
  type LifecycleEvent,
  type ListenerRegistrationError,
} from "../v2/moltzap/lifecycle.ts";
import type { ListenerHandle } from "../v2/moltzap/types.ts";

const handle = { __brand: "ListenerHandle" } as ListenerHandle;

function happyPath(): LifecycleState {
  let s = INITIAL;
  for (const ev of [
    { _tag: "StdioConnectStarted" },
    { _tag: "StdioConnected" },
    { _tag: "MoltzapConnectStarted" },
    { _tag: "MoltzapReady" },
    { _tag: "ListenerRegistered", handle },
  ] as LifecycleEvent[]) {
    const r = transition(s, ev);
    if (r._tag !== "Next") throw new Error(`happy path broke at ${ev._tag}`);
    s = r.state;
  }
  return s;
}

describe("lifecycle.transition — happy path", () => {
  it("INIT → STDIO_CONNECTING → STDIO_READY → MOLTZAP_CONNECTING → MOLTZAP_READY → LISTENING", () => {
    const terminal = happyPath();
    expect(terminal._tag).toBe("LISTENING");
    expect(isListening(terminal)).toBe(true);
    expect(isMoltzapReady(terminal)).toBe(true);
  });
});

describe("lifecycle.transition — failure branches", () => {
  it("StdioFailed from STDIO_CONNECTING → FAILED(TransportConnectError)", () => {
    const r1 = transition(INITIAL, { _tag: "StdioConnectStarted" });
    expect(r1._tag).toBe("Next");
    if (r1._tag !== "Next") return;
    const r2 = transition(r1.state, { _tag: "StdioFailed", cause: "ECONNREFUSED" });
    expect(r2._tag).toBe("Next");
    if (r2._tag !== "Next") return;
    expect(r2.state._tag).toBe("FAILED");
    if (r2.state._tag !== "FAILED") return;
    expect(r2.state.cause._tag).toBe("TransportConnectError");
  });

  it("MoltzapFailed from MOLTZAP_CONNECTING → FAILED(MoltzapHandshakeError)", () => {
    let s = INITIAL;
    for (const ev of [
      { _tag: "StdioConnectStarted" },
      { _tag: "StdioConnected" },
      { _tag: "MoltzapConnectStarted" },
    ] as LifecycleEvent[]) {
      const r = transition(s, ev);
      if (r._tag !== "Next") throw new Error("setup broke");
      s = r.state;
    }
    const r = transition(s, { _tag: "MoltzapFailed", cause: "handshake timeout" });
    expect(r._tag).toBe("Next");
    if (r._tag !== "Next") return;
    expect(r.state._tag).toBe("FAILED");
    if (r.state._tag !== "FAILED") return;
    expect(r.state.cause._tag).toBe("MoltzapHandshakeError");
  });

  it("ListenerFailed from MOLTZAP_READY → FAILED(ListenerRegistrationError)", () => {
    let s = INITIAL;
    for (const ev of [
      { _tag: "StdioConnectStarted" },
      { _tag: "StdioConnected" },
      { _tag: "MoltzapConnectStarted" },
      { _tag: "MoltzapReady" },
    ] as LifecycleEvent[]) {
      const r = transition(s, ev);
      if (r._tag !== "Next") throw new Error("setup broke");
      s = r.state;
    }
    const cause: ListenerRegistrationError = {
      _tag: "SDKRejected",
      cause: "SDK-ERROR-42",
    };
    const r = transition(s, { _tag: "ListenerFailed", cause });
    expect(r._tag).toBe("Next");
    if (r._tag !== "Next") return;
    expect(r.state._tag).toBe("FAILED");
    if (r.state._tag !== "FAILED") return;
    expect(r.state.cause._tag).toBe("ListenerRegistrationError");
  });
});

describe("lifecycle.transition — shutdown", () => {
  it("DrainRequested from LISTENING → DRAINING", () => {
    const listening = happyPath();
    const r = transition(listening, {
      _tag: "DrainRequested",
      reason: { _tag: "SigTerm" },
    });
    expect(r._tag).toBe("Next");
    if (r._tag !== "Next") return;
    expect(r.state._tag).toBe("DRAINING");
  });

  it("DrainRequested from INIT → DRAINING (any non-terminal state)", () => {
    const r = transition(INITIAL, {
      _tag: "DrainRequested",
      reason: { _tag: "McpDisconnect" },
    });
    expect(r._tag).toBe("Next");
  });

  it("DrainRequested from STOPPED → Illegal", () => {
    const r1 = transition(INITIAL, { _tag: "Stopped" });
    expect(r1._tag).toBe("Next");
    if (r1._tag !== "Next") return;
    const r2 = transition(r1.state, {
      _tag: "DrainRequested",
      reason: { _tag: "SigTerm" },
    });
    expect(r2._tag).toBe("Illegal");
  });

  it("Stopped from DRAINING → STOPPED", () => {
    const r1 = transition(INITIAL, {
      _tag: "DrainRequested",
      reason: { _tag: "SigTerm" },
    });
    expect(r1._tag).toBe("Next");
    if (r1._tag !== "Next") return;
    const r2 = transition(r1.state, { _tag: "Stopped" });
    expect(r2._tag).toBe("Next");
    if (r2._tag !== "Next") return;
    expect(r2.state._tag).toBe("STOPPED");
  });

  it("Stopped from FAILED → Illegal (preserve failure cause)", () => {
    // Drive to FAILED via StdioFailed, then check a late Stopped is rejected
    // and does not overwrite the LifecycleError.
    const r1 = transition(INITIAL, { _tag: "StdioConnectStarted" });
    if (r1._tag !== "Next") throw new Error("setup broke");
    const r2 = transition(r1.state, { _tag: "StdioFailed", cause: "boom" });
    expect(r2._tag).toBe("Next");
    if (r2._tag !== "Next") return;
    expect(r2.state._tag).toBe("FAILED");
    const r3 = transition(r2.state, { _tag: "Stopped" });
    expect(r3._tag).toBe("Illegal");
  });
});

describe("lifecycle.transition — illegal events", () => {
  it("StdioConnected from INIT is illegal (skips STDIO_CONNECTING)", () => {
    const r = transition(INITIAL, { _tag: "StdioConnected" });
    expect(r._tag).toBe("Illegal");
  });

  it("ListenerRegistered from STDIO_READY is illegal (skips MOLTZAP_READY)", () => {
    const r1 = transition(INITIAL, { _tag: "StdioConnectStarted" });
    if (r1._tag !== "Next") throw new Error("setup broke");
    const r2 = transition(r1.state, { _tag: "StdioConnected" });
    if (r2._tag !== "Next") throw new Error("setup broke");
    const r = transition(r2.state, { _tag: "ListenerRegistered", handle });
    expect(r._tag).toBe("Illegal");
  });

  it("StdioConnectStarted from LISTENING is illegal", () => {
    const listening = happyPath();
    const r = transition(listening, { _tag: "StdioConnectStarted" });
    expect(r._tag).toBe("Illegal");
  });
});

describe("lifecycle — readiness probes", () => {
  it("isListening only true in LISTENING", () => {
    expect(isListening(INITIAL)).toBe(false);
    expect(isListening(happyPath())).toBe(true);
  });

  it("isMoltzapReady true in MOLTZAP_READY and LISTENING", () => {
    let s = INITIAL;
    for (const ev of [
      { _tag: "StdioConnectStarted" },
      { _tag: "StdioConnected" },
      { _tag: "MoltzapConnectStarted" },
      { _tag: "MoltzapReady" },
    ] as LifecycleEvent[]) {
      const r = transition(s, ev);
      if (r._tag !== "Next") throw new Error("setup broke");
      s = r.state;
    }
    expect(isMoltzapReady(s)).toBe(true);
    expect(isListening(s)).toBe(false);
  });

  it("isMoltzapReady false before MOLTZAP_READY", () => {
    expect(isMoltzapReady(INITIAL)).toBe(false);
    const r = transition(INITIAL, { _tag: "StdioConnectStarted" });
    if (r._tag !== "Next") throw new Error("setup broke");
    expect(isMoltzapReady(r.state)).toBe(false);
  });
});
