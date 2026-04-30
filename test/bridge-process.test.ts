/**
 * Tests for the bridge process orchestrator that was relocated out of
 * `bin/webhook-bridge.ts` (sbd#202). Exercises the helpers (`loadBridgeInputs`,
 * `buildBridgeConfig`, `formatConfigError`, `formatIngressError`) and the
 * `runBridgeProcess` glue itself via dependency injection.
 *
 * Architect rev 4 §2: the bin is now ≤30 LOC of glue calling
 * `runBridgeProcess`. The sequencer that owns config load + signal
 * handlers + lifecycle ordering is in `src/bridge.ts` and is now
 * reachable by tests without a process fork.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildBridgeConfig,
  formatConfigError,
  formatIngressError,
  loadBridgeInputs,
  runBridgeProcess,
  type BridgeConfig,
  type RunningBridge,
} from "../src/bridge.ts";

describe("bridge-process: formatConfigError", () => {
  it("formats every config-error tag", () => {
    expect(formatConfigError({ _tag: "InvalidPort", raw: "abc" })).toContain(
      "ZAPBOT_PORT",
    );
    expect(
      formatConfigError({ _tag: "SecretCollision", left: "A", right: "B" }),
    ).toContain("must not equal");
    expect(
      formatConfigError({ _tag: "ConfigFileUnreadable", path: "/x", cause: "ENOENT" }),
    ).toContain("/x");
    expect(
      formatConfigError({ _tag: "ConfigFileInvalid", path: "/x", cause: "bad yaml" }),
    ).toContain("Invalid config file");
    expect(
      formatConfigError({ _tag: "CanonicalConfigMissing", path: "/x" }),
    ).toContain("zapbot-team-init");
    expect(
      formatConfigError({ _tag: "CanonicalConfigInvalid", path: "/x", cause: "bad json" }),
    ).toContain("Invalid canonical config");
    expect(
      formatConfigError({
        _tag: "DeprecatedSecretBinding",
        projectName: "demo",
        secretEnvVar: "OLD_SECRET",
      } as Parameters<typeof formatConfigError>[0]),
    ).toContain("deprecated");
    expect(formatConfigError({ _tag: "ReloadRejected", reason: "stale" })).toContain(
      "stale",
    );
  });
});

describe("bridge-process: formatIngressError", () => {
  it("formats every ingress-error tag", () => {
    expect(formatIngressError({ _tag: "InvalidIngressMode", mode: "weird" })).toContain(
      "weird",
    );
    expect(formatIngressError({ _tag: "MissingPublicBridgeUrl" })).toContain(
      "ZAPBOT_BRIDGE_URL",
    );
    expect(
      formatIngressError({
        _tag: "UnreachablePublicBridgeUrl",
        publicUrl: "http://dead.example",
      }),
    ).toContain("http://dead.example");
    expect(formatIngressError({ _tag: "DemoModeRequiresGateway" })).toContain(
      "ZAPBOT_GATEWAY_URL",
    );
  });
});

describe("bridge-process: loadBridgeInputs", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "zapbot-bridge-inputs-"));
    mkdirSync(join(tempHome, ".zapbot"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("rejects when canonical config is missing", async () => {
    const result = await loadBridgeInputs(
      { HOME: tempHome },
      undefined,
      async () => true,
    );
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error.reason).toContain("Canonical config not found");
  });

  it("loads a valid canonical config in local-only mode", async () => {
    writeFileSync(
      join(tempHome, ".zapbot", "config.json"),
      JSON.stringify({ webhookSecret: "wh-secret", apiKey: "api-key", orchestratorSecret: "test-orch-secret" }),
    );
    const result = await loadBridgeInputs(
      {
        HOME: tempHome,
        ZAPBOT_BOT_USERNAME: "test-bot",
        // No ZAPBOT_GATEWAY_URL → local-only ingress.
      },
      undefined,
      async () => true,
    );
    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok") return;
    expect(result.value.ingress.mode).toBe("local-only");
  });
});

describe("bridge-process: buildBridgeConfig", () => {
  it("propagates Moltzap decode failures as a typed reason", () => {
    // Force a Moltzap decode failure: serverUrl set but no registration
    // secret (rev 4 §8.1 path A invariant).
    const result = buildBridgeConfig(
      {
        ZAPBOT_MOLTZAP_SERVER_URL: "wss://moltzap.example/ws",
        // No ZAPBOT_MOLTZAP_REGISTRATION_SECRET → decode fails.
      },
      {
        port: 3000,
        ingress: { mode: "local-only" },
        publicUrl: null,
        gatewayUrl: null,
        gatewaySecret: null,
        botUsername: "test-bot" as never,
        aoConfigPath: null,
        apiKey: "api-key",
        webhookSecret: "wh-secret",
        routes: new Map(),
      } as never,
    );
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error.reason).toContain("ZAPBOT_MOLTZAP_REGISTRATION_SECRET");
  });
});

describe("bridge-process: runBridgeProcess (DI smoke test)", () => {
  let tempHome: string;
  let originalEnv: NodeJS.ProcessEnv;
  let preexistingListeners: {
    SIGHUP: ((...args: unknown[]) => void)[];
    SIGINT: ((...args: unknown[]) => void)[];
    SIGTERM: ((...args: unknown[]) => void)[];
  };

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "zapbot-run-bridge-"));
    mkdirSync(join(tempHome, ".zapbot"), { recursive: true });
    writeFileSync(
      join(tempHome, ".zapbot", "config.json"),
      JSON.stringify({ webhookSecret: "wh-secret", apiKey: "api-key", orchestratorSecret: "test-orch-secret" }),
    );
    originalEnv = { ...process.env };
    // Snapshot existing signal listeners (e.g. Vitest's own) so afterEach
    // only strips listeners installed by the test, not the harness's.
    preexistingListeners = {
      SIGHUP: [...process.listeners("SIGHUP")] as never,
      SIGINT: [...process.listeners("SIGINT")] as never,
      SIGTERM: [...process.listeners("SIGTERM")] as never,
    };
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    // Strip only listeners installed by runBridgeProcess; preserve the
    // pre-existing listener set so Vitest's own SIGINT handler survives.
    for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) {
      for (const listener of process.listeners(signal)) {
        if (!preexistingListeners[signal].includes(listener as never)) {
          process.off(signal, listener as never);
        }
      }
    }
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, originalEnv);
  });

  it("installs SIGHUP, SIGINT, SIGTERM handlers when the start delegate succeeds", async () => {
    let stopped = false;
    let reloaded = false;
    const fakeRunning: RunningBridge = {
      stop: async () => {
        stopped = true;
      },
      reload: async () => {
        reloaded = true;
      },
    };

    const env: NodeJS.ProcessEnv = {
      HOME: tempHome,
      ZAPBOT_BOT_USERNAME: "test-bot",
      // local-only ingress — no Moltzap decode required.
    };

    let started: BridgeConfig | null = null;
    await runBridgeProcess(env, {
      start: async (cfg) => {
        started = cfg;
        return fakeRunning;
      },
      probe: async () => true,
    });

    expect(started).not.toBeNull();
    expect(started?.ingress.mode).toBe("local-only");
    // Newly installed listeners — counted against the pre-existing
    // baseline so we are not just observing harness handlers.
    expect(process.listenerCount("SIGHUP")).toBe(preexistingListeners.SIGHUP.length + 1);
    expect(process.listenerCount("SIGINT")).toBe(preexistingListeners.SIGINT.length + 1);
    expect(process.listenerCount("SIGTERM")).toBe(preexistingListeners.SIGTERM.length + 1);
    // Lifecycle hooks not yet exercised — just installed.
    expect(stopped).toBe(false);
    expect(reloaded).toBe(false);
  });

  it("SIGHUP triggers a config reload that calls running.reload with the next config", async () => {
    let reloadCount = 0;
    let lastReloadConfig: BridgeConfig | null = null;
    const fakeRunning: RunningBridge = {
      stop: async () => {
        /* no-op */
      },
      reload: async (next) => {
        reloadCount += 1;
        lastReloadConfig = next;
      },
    };

    const env: NodeJS.ProcessEnv = {
      HOME: tempHome,
      ZAPBOT_BOT_USERNAME: "test-bot",
    };

    await runBridgeProcess(env, {
      start: async () => fakeRunning,
      probe: async () => true,
    });

    // Capture the SIGHUP handler that runBridgeProcess just installed.
    const handlers = process.listeners("SIGHUP");
    const ourHandler = handlers[handlers.length - 1] as (() => void) | undefined;
    expect(ourHandler).toBeDefined();

    // Fire the handler synchronously; it kicks off an IIFE.
    ourHandler!();
    // Wait for the async reload work to settle.
    await new Promise((r) => setTimeout(r, 50));

    expect(reloadCount).toBe(1);
    expect(lastReloadConfig).not.toBeNull();
    expect(lastReloadConfig?.ingress.mode).toBe("local-only");
  });

  it("SIGHUP coalesces concurrent reloads (reloadInFlight gate)", async () => {
    let reloadCount = 0;
    let releaseReload!: () => void;
    const reloadGate = new Promise<void>((r) => {
      releaseReload = r;
    });
    const fakeRunning: RunningBridge = {
      stop: async () => {
        /* no-op */
      },
      reload: async () => {
        reloadCount += 1;
        // Block the first reload until the test releases it.
        if (reloadCount === 1) await reloadGate;
      },
    };

    const env: NodeJS.ProcessEnv = {
      HOME: tempHome,
      ZAPBOT_BOT_USERNAME: "test-bot",
    };

    await runBridgeProcess(env, {
      start: async () => fakeRunning,
      probe: async () => true,
    });

    const handlers = process.listeners("SIGHUP");
    const ourHandler = handlers[handlers.length - 1] as (() => void) | undefined;

    // Fire twice rapidly. The second should be coalesced under the
    // reloadInFlight gate.
    ourHandler!();
    ourHandler!();
    // Let the queued microtasks run, then release the first reload.
    await new Promise((r) => setTimeout(r, 20));
    releaseReload();
    await new Promise((r) => setTimeout(r, 50));

    expect(reloadCount).toBe(1);
  });

  it("probe returning false is non-fatal in github-demo mode — bridge starts and logs a warning", async () => {
    // runBridgeProcess passes async () => true as isPublicUrlReachable during
    // initial config load (bridge not live yet). The post-boot probe is the
    // separate `overrides.probe` below, which simulates a hairpin-NAT host.
    let started = false;
    const fakeRunning: RunningBridge = {
      stop: async () => { /* no-op */ },
      reload: async () => { /* no-op */ },
    };

    const env: NodeJS.ProcessEnv = {
      HOME: tempHome,
      ZAPBOT_BOT_USERNAME: "test-bot",
      ZAPBOT_GATEWAY_URL: "http://gateway.example.com",
      ZAPBOT_BRIDGE_URL: "http://bridge.example.com",
    };

    const captured: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    const spy = (chunk: string | Uint8Array, ...args: unknown[]) => {
      if (typeof chunk === "string") captured.push(chunk);
      return (originalWrite as (...a: unknown[]) => boolean)(chunk, ...args);
    };
    process.stdout.write = spy as typeof process.stdout.write;

    try {
      await runBridgeProcess(env, {
        start: async () => {
          started = true;
          return fakeRunning;
        },
        probe: async () => false,
      });
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(started).toBe(true);
    const allOutput = captured.join("");
    expect(allOutput).toContain("boot_probe_unreachable");
    expect(allOutput).toContain("http://bridge.example.com");
  });
});
