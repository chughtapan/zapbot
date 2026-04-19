import { describe, it, expect } from "vitest";
import { register, type MoltzapRegistrar } from "../v2/moltzap/listener.ts";
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

describe("listener.register — pre-ready rejection", () => {
  it("INIT → NotReady (sub-issue AC1.1 / Q2 option (a): forbid pre-ready attach)", async () => {
    const registrar: MoltzapRegistrar = async () => {
      throw new Error("registrar must not be called pre-ready");
    };
    const result = await register(INITIAL, sdk, noopCb, registrar);
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
    const result = await register(s, sdk, noopCb, registrar);
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
    const result = await register(s, sdk, noopCb, registrar);
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
    const result = await register(state, sdk, noopCb, registrar);
    expect(result._tag).toBe("Ok");
    expect(calls).toBe(1);
  });
});

describe("listener.register — SDK rejection", () => {
  it("registrar returns Err → Err(SDKRejected)", async () => {
    const state = driveTo(READY_PATH);
    const registrar: MoltzapRegistrar = async () =>
      err({ _tag: "SDKRejected", cause: "SDK timed out during onMessage wiring" });
    const result = await register(state, sdk, noopCb, registrar);
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
    const result = await register(state, sdk, noopCb, registrar);
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
    const result = await register(listening, sdk, noopCb, registrar);
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("NotReady");
  });
});
