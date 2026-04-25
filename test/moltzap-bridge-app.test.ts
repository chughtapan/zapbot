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
import { Effect, Fiber } from "effect";
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

describe("bridge-app: concurrent boot coalesces — singleton race guard (P1 #3 regression)", () => {
  // Regression for the TOCTOU in the original bootBridgeApp: __bridgeSingleton
  // guard ran BEFORE the first async yield (registerBridgeAgent), so two
  // concurrent callers could both pass the guard, both register, both create a
  // MoltZapApp, and both start it — leaving one orphaned with an open WS.
  //
  // Fix: __bootInFlight sentinel is assigned synchronously (no yield*) before
  // the first async operation. The second caller sees it and coalesces.

  it("two concurrent calls with registration failure: one fetch call, both callers fail with BridgeAppRegistrationFailed", async () => {
    let fetchCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      fetchCount++;
      return new Response("forbidden", { status: 403 });
    });

    const config = {
      serverUrl: "https://moltzap.example",
      env: { ZAPBOT_MOLTZAP_REGISTRATION_SECRET: "test-secret" },
    };

    const [r1, r2] = await Promise.all([
      Effect.runPromise(bootBridgeApp(config).pipe(Effect.either)),
      Effect.runPromise(bootBridgeApp(config).pipe(Effect.either)),
    ]);

    // Only one registration RPC sent — second caller coalesced onto the in-flight boot.
    expect(fetchCount).toBe(1);
    // Both callers surface the same failure tag.
    expect(r1._tag).toBe("Left");
    expect(r2._tag).toBe("Left");
    if (r1._tag === "Left") expect(r1.left._tag).toBe("BridgeAppRegistrationFailed");
    if (r2._tag === "Left") expect(r2.left._tag).toBe("BridgeAppRegistrationFailed");
  });

  it("sentinel clears on failure — a subsequent boot attempt makes a fresh registration call", async () => {
    let fetchCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      fetchCount++;
      return new Response("forbidden", { status: 403 });
    });

    const config = {
      serverUrl: "https://moltzap.example",
      env: { ZAPBOT_MOLTZAP_REGISTRATION_SECRET: "test-secret" },
    };

    // First attempt fails; sentinel is cleared inside bootBridgeApp on failure.
    await Effect.runPromise(bootBridgeApp(config).pipe(Effect.either));
    expect(fetchCount).toBe(1);

    // Second attempt should start a fresh boot (not coalesce onto the cleared sentinel).
    await Effect.runPromise(bootBridgeApp(config).pipe(Effect.either));
    expect(fetchCount).toBe(2); // sentinel was cleared → new fetch
  });
});

describe("bridge-app: sentinel cleanup under fiber interruption (Fix 1 — sbd#204)", () => {
  // Regression for: a boot fiber interrupted between sentinel-assign and the
  // success/failure clear leaves __bootInFlight permanently non-null, causing
  // all subsequent bootBridgeApp callers to deadlock awaiting a Promise that
  // will never resolve. Fix: Effect.ensuring in bootBridgeApp always clears
  // __bootInFlight, even on interruption.

  it("interrupted boot clears sentinel — subsequent boot starts fresh and does not deadlock", async () => {
    // A Promise that the mock fetch awaits; we hold it open to keep the boot
    // fiber suspended in the registration step so we can interrupt it.
    let signalFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((res) => {
      signalFetchStarted = res;
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      signalFetchStarted();
      // Block indefinitely until the fiber is interrupted.
      await new Promise<void>(() => {}); // never resolves
      // Unreachable; TypeScript needs a return.
      return new Response("ok", { status: 200 });
    });

    const config = {
      serverUrl: "https://moltzap.example",
      env: { ZAPBOT_MOLTZAP_REGISTRATION_SECRET: "secret" },
    };

    // Fork the boot, wait until it is in-flight, then interrupt.
    await Effect.runPromise(
      Effect.gen(function* () {
        const bootFiber = yield* Effect.fork(bootBridgeApp(config));
        // Wait until fetch has been called (sentinel is assigned, boot is async).
        yield* Effect.promise(() => fetchStarted);
        // Interrupt. Effect.ensuring in bootBridgeApp clears __bootInFlight.
        yield* Fiber.interrupt(bootFiber);
      }),
    );

    // After interrupt: sentinel should be null. Re-mock fetch to return 403.
    let freshFetchCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      freshFetchCount++;
      return new Response("forbidden", { status: 403 });
    });

    // Fresh boot must NOT deadlock — it should start a new registration call.
    const result = await Effect.runPromise(
      bootBridgeApp(config).pipe(Effect.either),
    );

    expect(freshFetchCount).toBe(1); // new fetch call confirms sentinel was cleared
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("BridgeAppRegistrationFailed");
    }
  });
});

describe("bridge-app: shutdown-vs-boot ordering (Fix 2 — sbd#204)", () => {
  // Regression for: shutdownBridgeApp called while a boot is in-flight
  // would no-op immediately (singleton still null), then the boot would
  // complete and leave a ghost MoltZapApp that nothing tears down.
  // Fix: shutdownBridgeApp awaits __bootInFlight before inspecting the
  // singleton (option a — see function docstring).

  it("shutdownBridgeApp waits for in-flight boot to settle before tearing down", async () => {
    let allowBootToComplete!: () => void;
    const bootCanComplete = new Promise<void>((res) => {
      allowBootToComplete = res;
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await bootCanComplete;
      return new Response("forbidden", { status: 403 });
    });

    const config = {
      serverUrl: "https://moltzap.example",
      env: { ZAPBOT_MOLTZAP_REGISTRATION_SECRET: "secret" },
    };

    // Start boot; do not await yet.
    const bootPromise = Effect.runPromise(
      bootBridgeApp(config).pipe(Effect.either),
    );

    // Yield one tick so boot has time to assign the sentinel.
    await new Promise<void>((res) => setTimeout(res, 0));

    // Start shutdown while boot is in-flight.
    // With Fix 2: shutdown awaits __bootInFlight, so it must block here.
    let shutdownSettled = false;
    const shutdownPromise = Effect.runPromise(shutdownBridgeApp()).then(() => {
      shutdownSettled = true;
    });

    // Yield another tick; without Fix 2, shutdown would have resolved already.
    await new Promise<void>((res) => setTimeout(res, 0));
    expect(shutdownSettled).toBe(false); // shutdown is still waiting for boot

    // Unblock the boot (registration returns 403; __bridgeSingleton stays null).
    allowBootToComplete();

    await bootPromise;
    await shutdownPromise;

    // Both settled; no ghost singleton.
    expect(shutdownSettled).toBe(true);
    expect(bridgeAgentId()).toBeNull();
    expect(currentBridgeApp()).toBeNull();
  });
});
