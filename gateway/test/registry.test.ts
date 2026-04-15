import { describe, it, expect, beforeEach } from "vitest";
import {
  registerBridge,
  deregisterBridge,
  getBridge,
  getAllBridges,
  touchBridge,
  sweepStaleBridges,
  clearRegistry,
} from "../src/registry.js";

beforeEach(() => {
  clearRegistry();
});

describe("registry", () => {
  it("registers a bridge and retrieves it by repo", () => {
    registerBridge("acme/app", "https://bridge1.example.com");
    const entry = getBridge("acme/app");
    expect(entry).toBeDefined();
    expect(entry!.repo).toBe("acme/app");
    expect(entry!.bridgeUrl).toBe("https://bridge1.example.com");
    expect(entry!.active).toBe(true);
  });

  it("returns undefined for unregistered repo", () => {
    expect(getBridge("unknown/repo")).toBeUndefined();
  });

  it("updates bridgeUrl on re-registration", () => {
    registerBridge("acme/app", "https://old.example.com");
    registerBridge("acme/app", "https://new.example.com");
    const entry = getBridge("acme/app");
    expect(entry!.bridgeUrl).toBe("https://new.example.com");
  });

  it("preserves original registeredAt on re-registration", () => {
    const first = registerBridge("acme/app", "https://old.example.com");
    const second = registerBridge("acme/app", "https://new.example.com");
    expect(second.registeredAt).toBe(first.registeredAt);
  });

  it("deregisters a bridge", () => {
    registerBridge("acme/app", "https://bridge1.example.com");
    expect(deregisterBridge("acme/app")).toBe(true);
    expect(getBridge("acme/app")).toBeUndefined();
  });

  it("deregister returns false for unknown repo", () => {
    expect(deregisterBridge("unknown/repo")).toBe(false);
  });

  it("lists all bridges", () => {
    registerBridge("acme/app", "https://b1.example.com");
    registerBridge("acme/api", "https://b2.example.com");
    expect(getAllBridges()).toHaveLength(2);
  });

  it("touchBridge updates lastSeen and reactivates", () => {
    const entry = registerBridge("acme/app", "https://b.example.com");
    // Manually mark inactive
    entry.active = false;
    touchBridge("acme/app");
    expect(getBridge("acme/app")).toBeDefined();
    expect(getBridge("acme/app")!.active).toBe(true);
  });

  it("sweeps stale bridges past timeout", () => {
    const entry = registerBridge("acme/app", "https://b.example.com");
    // Backdate lastSeen
    entry.lastSeen = Date.now() - 120_000;
    const swept = sweepStaleBridges(60_000);
    expect(swept).toEqual(["acme/app"]);
    expect(getBridge("acme/app")).toBeUndefined();
  });

  it("does not sweep recently seen bridges", () => {
    registerBridge("acme/app", "https://b.example.com");
    const swept = sweepStaleBridges(60_000);
    expect(swept).toEqual([]);
    expect(getBridge("acme/app")).toBeDefined();
  });

  it("getBridge returns undefined for inactive bridges", () => {
    const entry = registerBridge("acme/app", "https://b.example.com");
    entry.active = false;
    expect(getBridge("acme/app")).toBeUndefined();
  });
});
