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
      JSON.stringify({ webhookSecret: "wh-secret", apiKey: "api-key" }),
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

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "zapbot-run-bridge-"));
    mkdirSync(join(tempHome, ".zapbot"), { recursive: true });
    writeFileSync(
      join(tempHome, ".zapbot", "config.json"),
      JSON.stringify({ webhookSecret: "wh-secret", apiKey: "api-key" }),
    );
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    // Strip any signal listeners runBridgeProcess installed.
    process.removeAllListeners("SIGHUP");
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    // Restore env in case any test mutated it.
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
    // Signal handlers were installed.
    expect(process.listenerCount("SIGHUP")).toBeGreaterThan(0);
    expect(process.listenerCount("SIGINT")).toBeGreaterThan(0);
    expect(process.listenerCount("SIGTERM")).toBeGreaterThan(0);
    // Lifecycle hooks not yet exercised — just installed.
    expect(stopped).toBe(false);
    expect(reloaded).toBe(false);
  });
});
