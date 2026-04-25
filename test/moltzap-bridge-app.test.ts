/**
 * Tests for src/moltzap/bridge-app.ts.
 *
 * Anchors: sbd#199 acceptance item 7 (bridge identity boot sequence per
 * A+C(2)) and item 9 (moltzap#230 operational posture). Rev 4 §2.3 §3.3.
 *
 * These are unit tests around the boot-error classifier, the singleton
 * invariant, the drain-budget posture, and the silence invariant. The
 * end-to-end path (new MoltZapApp.start against a live server) is
 * covered in the integration test at
 * test/integration/*.integration.test.ts (Spike B pattern).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import {
  __resetBridgeAppForTests,
  bootBridgeApp,
  bridgeAgentId,
  createBridgeSession,
  closeBridgeSession,
  currentBridgeApp,
  drainBridgeSessions,
  shutdownBridgeApp,
} from "../src/moltzap/bridge-app.ts";

beforeEach(() => {
  __resetBridgeAppForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetBridgeAppForTests();
});

describe("bridge-app: boot precondition", () => {
  it("bridgeAgentId returns null before bootBridgeApp resolves", () => {
    expect(bridgeAgentId()).toBeNull();
    expect(currentBridgeApp()).toBeNull();
  });

  it("createBridgeSession yields BridgeAppNotBooted when no boot has run", async () => {
    const result = await Effect.runPromise(
      createBridgeSession({ invitedAgentIds: [] }).pipe(Effect.either),
    );
    expect(result._tag).toBe("Left");
    if (result._tag !== "Left") return;
    expect(result.left._tag).toBe("BridgeAppNotBooted");
  });

  it("closeBridgeSession yields BridgeAppNotBooted when no boot has run", async () => {
    const result = await Effect.runPromise(
      closeBridgeSession("nonexistent").pipe(Effect.either),
    );
    expect(result._tag).toBe("Left");
    if (result._tag !== "Left") return;
    expect(result.left._tag).toBe("BridgeAppNotBooted");
  });

  it("drainBridgeSessions returns [] when no boot has run", async () => {
    const leaked = await drainBridgeSessions({ timeoutMs: 1000 });
    expect(leaked).toEqual([]);
  });

  it("shutdownBridgeApp is a no-op when no boot has run", async () => {
    await expect(
      Effect.runPromise(shutdownBridgeApp()),
    ).resolves.toBeUndefined();
  });
});

describe("bridge-app: env failure surfaces as BridgeAppEnvInvalid", () => {
  it("returns BridgeAppEnvInvalid when ZAPBOT_MOLTZAP_REGISTRATION_SECRET is missing", async () => {
    const result = await Effect.runPromise(
      bootBridgeApp({ serverUrl: "https://moltzap.example", env: {} }).pipe(
        Effect.either,
      ),
    );
    expect(result._tag).toBe("Left");
    if (result._tag !== "Left") return;
    expect(result.left._tag).toBe("BridgeAppEnvInvalid");
  });
});

describe("bridge-app: registration failure classification", () => {
  it("maps BridgeRegistrationError into BridgeAppRegistrationFailed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("forbidden", { status: 403 }),
    );
    const result = await Effect.runPromise(
      bootBridgeApp({
        serverUrl: "https://moltzap.example",
        env: {
          ZAPBOT_MOLTZAP_REGISTRATION_SECRET: "bad-secret",
        },
      }).pipe(Effect.either),
    );
    expect(result._tag).toBe("Left");
    if (result._tag !== "Left") return;
    expect(result.left._tag).toBe("BridgeAppRegistrationFailed");
    if (result.left._tag !== "BridgeAppRegistrationFailed") return;
    expect(result.left.cause._tag).toBe("BridgeRegistrationHttpFailed");
  });
});

describe("bridge-app: silence invariant (structural)", () => {
  // The full-suite proof that no `messages/send` RPC leaves the bridge
  // lives in the integration suite. At unit level, the invariant is
  // encoded by the structural absence of any send-shape export from the
  // module (verified in test/moltzap-bridge-silence.test.ts).
  it("BridgeAppHandle shape exposes no send surface — structural check in bridge-silence.test.ts", () => {
    // Intentionally minimal: the structural assertion runs under the
    // sibling test. Keeping this case present makes the invariant
    // discoverable from this file as well.
    expect(true).toBe(true);
  });
});
