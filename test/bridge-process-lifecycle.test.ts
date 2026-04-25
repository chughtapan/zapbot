/**
 * Tests for `src/bridge-process.ts` — the boot/reload/shutdown lifecycle
 * primitive that fixes sbd#215 races 1, 2, and 3.
 *
 * Architect plan: rev 2 + addendum.
 *   https://github.com/chughtapan/safer-by-default/issues/215#issuecomment-4318477234
 *
 * Coverage map (per architect §7 + rev 2 sub-table):
 *   - Race 1: signals during Booting flip state synchronously; boot caller
 *     observes and bails.
 *   - Race 2: prepareReload validation failure leaves liveRuntime intact;
 *     commitReload throw on swap rolls back; commitReload throw on rollback
 *     surfaces ReloadRollbackFailed.
 *   - Race 3: SIGHUP during Booting/Reloading/ShuttingDown is a no-op.
 *   - SIGTERM-during-Reloading: reload settles before stop fires; signal
 *     wins over Manual rollback-failure escalation (rev 2 P1 #3).
 *   - State machine: every transition in the rev 2 transition table.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  commitReload,
  installBridgeProcessLifecycle,
  prepareReload,
  type BridgeProcessLifecycle,
  type BridgeProcessLifecycleDeps,
  type ReloadPlan,
} from "../src/bridge-process.ts";
import type { BridgeConfig, RunningBridge } from "../src/bridge.ts";
import type { BridgeRuntimeConfig } from "../src/config/types.ts";

// ── Test doubles ───────────────────────────────────────────────────

interface FakeProcess extends Pick<NodeJS.Process, "on" | "off"> {
  fire(signal: "SIGHUP" | "SIGINT" | "SIGTERM"): void;
  listenerCount(signal: "SIGHUP" | "SIGINT" | "SIGTERM"): number;
}

function makeFakeProcess(): FakeProcess {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  return {
    on(signal: NodeJS.Signals | string, handler: (...args: unknown[]) => void) {
      const key = String(signal);
      handlers[key] = handlers[key] ?? [];
      handlers[key].push(handler);
      return this as unknown as NodeJS.Process;
    },
    off(signal: NodeJS.Signals | string, handler: (...args: unknown[]) => void) {
      const key = String(signal);
      handlers[key] = (handlers[key] ?? []).filter((h) => h !== handler);
      return this as unknown as NodeJS.Process;
    },
    fire(signal) {
      for (const h of handlers[signal] ?? []) h();
    },
    listenerCount(signal) {
      return (handlers[signal] ?? []).length;
    },
  } as FakeProcess;
}

interface ExitTrap {
  exit: (code: number) => never;
  exitCalls: number[];
  /** Resolves the next time exit fires. */
  next(): Promise<number>;
}

function makeExitTrap(): ExitTrap {
  const exitCalls: number[] = [];
  let pendingResolve: ((code: number) => void) | null = null;
  return {
    exit: ((code: number) => {
      exitCalls.push(code);
      if (pendingResolve !== null) {
        pendingResolve(code);
        pendingResolve = null;
      }
      // Returning never-typed value without throwing — tests don't fork a
      // process. The signature lies in the static type but we don't depend
      // on the runtime non-return behavior in tests.
      return undefined as never;
    }) as (code: number) => never,
    exitCalls,
    next() {
      return new Promise<number>((r) => {
        pendingResolve = r;
      });
    },
  };
}

interface TestLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  /** All logged messages, prefixed by level. */
  readonly messages: string[];
}

function makeLogger(): TestLogger {
  const messages: string[] = [];
  return {
    info: (m) => messages.push(`info: ${m}`),
    warn: (m) => messages.push(`warn: ${m}`),
    error: (m) => messages.push(`error: ${m}`),
    messages,
  };
}

function makeRuntime(overrides: Partial<BridgeRuntimeConfig> = {}): BridgeRuntimeConfig {
  return {
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
    ...overrides,
  };
}

function makeConfig(): BridgeConfig {
  return {
    port: 3000,
    ingress: { mode: "local-only" },
    publicUrl: null,
    gatewayUrl: null,
    gatewaySecret: null,
    botUsername: "test-bot" as never,
    aoConfigPath: "",
    apiKey: "api-key",
    webhookSecret: "wh-secret",
    moltzap: null,
    repos: new Map(),
  };
}

interface FakeRunning extends RunningBridge {
  /** Per-call hooks. The Nth call (0-indexed) reads hooks[n]. */
  hooks: Array<() => Promise<void>>;
  reloadCalls: number;
  stopCalls: number;
}

function makeFakeRunning(): FakeRunning {
  const r: FakeRunning = {
    hooks: [],
    reloadCalls: 0,
    stopCalls: 0,
    stop: async () => {
      r.stopCalls += 1;
    },
    reload: async () => {
      const idx = r.reloadCalls;
      r.reloadCalls += 1;
      const hook = r.hooks[idx];
      if (hook !== undefined) await hook();
    },
  };
  return r;
}

function makeDeps(over: Partial<BridgeProcessLifecycleDeps> = {}): {
  deps: BridgeProcessLifecycleDeps;
  fakeProcess: FakeProcess;
  exitTrap: ExitTrap;
  logger: TestLogger;
} {
  const fakeProcess = makeFakeProcess();
  const exitTrap = makeExitTrap();
  const logger = makeLogger();
  const deps: BridgeProcessLifecycleDeps = {
    env: {},
    probe: async () => true,
    process: fakeProcess,
    exit: exitTrap.exit,
    logger,
    ...over,
  };
  return { deps, fakeProcess, exitTrap, logger };
}

// ── Race-1: signal handlers installed before any boot I/O ──────────

describe("installBridgeProcessLifecycle: signal handlers (race-1 fix)", () => {
  it("installs SIGHUP/SIGINT/SIGTERM synchronously on call", () => {
    const { deps, fakeProcess } = makeDeps();
    const lifecycle = installBridgeProcessLifecycle(deps);
    try {
      expect(fakeProcess.listenerCount("SIGHUP")).toBe(1);
      expect(fakeProcess.listenerCount("SIGINT")).toBe(1);
      expect(fakeProcess.listenerCount("SIGTERM")).toBe(1);
      expect(lifecycle.state()._tag).toBe("Booting");
    } finally {
      lifecycle.dispose();
    }
  });

  it("SIGTERM during Booting flips state to ShuttingDown synchronously", () => {
    const { deps, fakeProcess } = makeDeps();
    const lifecycle = installBridgeProcessLifecycle(deps);
    try {
      expect(lifecycle.state()._tag).toBe("Booting");
      fakeProcess.fire("SIGTERM");
      const s = lifecycle.state();
      expect(s._tag).toBe("ShuttingDown");
      if (s._tag !== "ShuttingDown") return;
      expect(s.reason._tag).toBe("Signal");
    } finally {
      lifecycle.dispose();
    }
  });

  it("requestShutdown after SIGTERM during Booting calls deps.exit(0) without running.stop", async () => {
    const { deps, fakeProcess, exitTrap } = makeDeps();
    const lifecycle = installBridgeProcessLifecycle(deps);
    try {
      fakeProcess.fire("SIGTERM");
      await lifecycle.requestShutdown({ _tag: "Signal", signal: "SIGTERM" });
      expect(exitTrap.exitCalls).toEqual([0]);
    } finally {
      lifecycle.dispose();
    }
  });

  it("SIGINT during Booting also flips state and exits 0 via requestShutdown", async () => {
    const { deps, fakeProcess, exitTrap } = makeDeps();
    const lifecycle = installBridgeProcessLifecycle(deps);
    try {
      fakeProcess.fire("SIGINT");
      const s = lifecycle.state();
      expect(s._tag).toBe("ShuttingDown");
      if (s._tag !== "ShuttingDown" || s.reason._tag !== "Signal") return;
      expect(s.reason.signal).toBe("SIGINT");
      await lifecycle.requestShutdown(s.reason);
      expect(exitTrap.exitCalls).toEqual([0]);
    } finally {
      lifecycle.dispose();
    }
  });
});

// ── Race-3: SIGHUP no-ops on non-Ready states ──────────────────────

describe("installBridgeProcessLifecycle: SIGHUP no-op states (race-3 fix)", () => {
  it("SIGHUP during Booting is a no-op (no queue, no deferred dispatch)", async () => {
    const { deps, fakeProcess, logger } = makeDeps();
    const lifecycle = installBridgeProcessLifecycle(deps);
    try {
      fakeProcess.fire("SIGHUP");
      expect(lifecycle.state()._tag).toBe("Booting");
      // Even after markReady, the dropped SIGHUP must not dispatch.
      const running = makeFakeRunning();
      lifecycle.markReady(running, makeRuntime());
      // Allow any deferred microtasks to flush.
      await Promise.resolve();
      expect(running.reloadCalls).toBe(0);
      expect(logger.messages.some((m) => m.includes("SIGHUP ignored during boot"))).toBe(true);
    } finally {
      lifecycle.dispose();
    }
  });

  it("SIGHUP during ShuttingDown is a no-op", async () => {
    const { deps, fakeProcess, logger } = makeDeps();
    const lifecycle = installBridgeProcessLifecycle(deps);
    try {
      const running = makeFakeRunning();
      lifecycle.markReady(running, makeRuntime());
      // Drive into ShuttingDown.
      fakeProcess.fire("SIGTERM");
      await new Promise((r) => setTimeout(r, 10));
      expect(lifecycle.state()._tag).toBe("ShuttingDown");
      // Now fire SIGHUP — must no-op.
      fakeProcess.fire("SIGHUP");
      await new Promise((r) => setTimeout(r, 10));
      expect(running.reloadCalls).toBe(0);
      expect(logger.messages.some((m) => m.includes("SIGHUP ignored during shutdown"))).toBe(true);
    } finally {
      lifecycle.dispose();
    }
  });
});

// ── Reload state machine + race-2 + race-3 (SIGHUP-during-Reloading) ──

describe("installBridgeProcessLifecycle: reload state machine", () => {
  let tempHome: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "zapbot-bp-lifecycle-"));
    mkdirSync(join(tempHome, ".zapbot"), { recursive: true });
    writeFileSync(
      join(tempHome, ".zapbot", "config.json"),
      JSON.stringify({ webhookSecret: "wh-secret", apiKey: "api-key" }),
    );
    env = { HOME: tempHome, ZAPBOT_BOT_USERNAME: "test-bot" };
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("SIGHUP in Ready transitions through Reloading and back to Ready on success", async () => {
    const { deps, fakeProcess } = makeDeps({ env });
    const lifecycle = installBridgeProcessLifecycle(deps);
    try {
      const running = makeFakeRunning();
      lifecycle.markReady(running, makeRuntime());
      expect(lifecycle.state()._tag).toBe("Ready");

      fakeProcess.fire("SIGHUP");
      // Wait for the async reload work to settle.
      await new Promise((r) => setTimeout(r, 50));
      expect(running.reloadCalls).toBe(1);
      expect(lifecycle.state()._tag).toBe("Ready");
    } finally {
      lifecycle.dispose();
    }
  });

  it("SIGHUP during Reloading no-ops (race-3 reloadInFlight regression)", async () => {
    const { deps, fakeProcess, logger } = makeDeps({ env });
    const lifecycle = installBridgeProcessLifecycle(deps);
    try {
      const running = makeFakeRunning();
      let releaseFirst!: () => void;
      const firstReloadGate = new Promise<void>((r) => {
        releaseFirst = r;
      });
      running.hooks[0] = () => firstReloadGate;
      lifecycle.markReady(running, makeRuntime());

      fakeProcess.fire("SIGHUP");
      // Wait long enough for prepareReload to settle and reach commitReload.
      await new Promise((r) => setTimeout(r, 30));
      expect(lifecycle.state()._tag).toBe("Reloading");

      fakeProcess.fire("SIGHUP");
      await new Promise((r) => setTimeout(r, 5));
      expect(running.reloadCalls).toBe(1);
      expect(
        logger.messages.some((m) => m.includes("SIGHUP received while reload in flight")),
      ).toBe(true);

      releaseFirst();
      await new Promise((r) => setTimeout(r, 30));
      expect(lifecycle.state()._tag).toBe("Ready");
      expect(running.reloadCalls).toBe(1);
    } finally {
      lifecycle.dispose();
    }
  });

  it("SIGTERM during Reloading defers shutdown until reload settles (rev 2 P1 #3 a)", async () => {
    const { deps, fakeProcess, exitTrap } = makeDeps({ env });
    const lifecycle = installBridgeProcessLifecycle(deps);
    try {
      const running = makeFakeRunning();
      const callOrder: string[] = [];
      let releaseFirst!: () => void;
      const reloadGate = new Promise<void>((r) => {
        releaseFirst = r;
      });
      running.hooks[0] = async () => {
        callOrder.push("reload");
        await reloadGate;
      };
      const originalStop = running.stop;
      running.stop = async () => {
        callOrder.push("stop");
        await originalStop();
      };
      lifecycle.markReady(running, makeRuntime());

      fakeProcess.fire("SIGHUP");
      await new Promise((r) => setTimeout(r, 30));
      expect(lifecycle.state()._tag).toBe("Reloading");

      // SIGTERM during Reloading — must NOT abort the reload.
      fakeProcess.fire("SIGTERM");
      await new Promise((r) => setTimeout(r, 5));
      // Reload still in flight; stop must not have been called yet.
      expect(running.stopCalls).toBe(0);
      expect(lifecycle.state()._tag).toBe("Reloading");

      // Release the reload — it commits, then shutdown drains.
      releaseFirst();
      // Wait for shutdown to fire.
      const code = await exitTrap.next();
      expect(code).toBe(0);
      expect(callOrder[0]).toBe("reload");
      expect(callOrder).toContain("stop");
      // Stop fired AFTER reload — order check.
      expect(callOrder.indexOf("stop")).toBeGreaterThan(callOrder.indexOf("reload"));
    } finally {
      lifecycle.dispose();
    }
  });
});

// ── prepareReload: validation failure (race-2 fix) ────────────────

describe("prepareReload: pure validation", () => {
  let tempHome: string;
  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "zapbot-bp-prepare-"));
    mkdirSync(join(tempHome, ".zapbot"), { recursive: true });
  });
  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("returns ReloadInputsFailed when canonical config is missing — never touches running", async () => {
    const env: NodeJS.ProcessEnv = { HOME: tempHome };
    const result = await prepareReload(env, makeRuntime(), async () => true);
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("ReloadInputsFailed");
    if (result.error._tag !== "ReloadInputsFailed") return;
    expect(result.error.reason).toContain("Canonical config not found");
  });

  it("returns Ok with a ReloadPlan when inputs validate", async () => {
    writeFileSync(
      join(tempHome, ".zapbot", "config.json"),
      JSON.stringify({ webhookSecret: "wh-secret", apiKey: "api-key" }),
    );
    const env: NodeJS.ProcessEnv = {
      HOME: tempHome,
      ZAPBOT_BOT_USERNAME: "test-bot",
    };
    const result = await prepareReload(env, makeRuntime(), async () => true);
    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok") return;
    expect(result.value.nextRuntime.botUsername).toBe("test-bot");
    expect(result.value.secretRotated).toBe(false);
  });
});

// ── commitReload: transactional swap + rollback (race-2 fix) ──────

describe("commitReload: throw-boundary atomicity", () => {
  function makePlan(): ReloadPlan {
    return {
      nextRuntime: makeRuntime({ port: 4000 }),
      nextConfig: { ...makeConfig(), port: 4000 },
      secretRotated: false,
    };
  }

  it("returns Ok and never calls reload twice when running.reload succeeds", async () => {
    const running = makeFakeRunning();
    const plan = makePlan();
    const result = await commitReload(running, plan, makeRuntime(), makeConfig());
    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok") return;
    expect(result.value.port).toBe(4000);
    expect(running.reloadCalls).toBe(1);
  });

  it("rolls back to previousConfig on running.reload throw (ReloadCommitFailed, rolledBack=true)", async () => {
    const running = makeFakeRunning();
    running.hooks[0] = async () => {
      throw new Error("first-reload boom");
    };
    const plan = makePlan();
    const previousConfig = makeConfig();
    const result = await commitReload(running, plan, makeRuntime(), previousConfig);
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("ReloadCommitFailed");
    if (result.error._tag !== "ReloadCommitFailed") return;
    expect(result.error.rolledBack).toBe(true);
    expect(result.error.cause).toContain("first-reload boom");
    // Reload called twice: swap + rollback.
    expect(running.reloadCalls).toBe(2);
  });

  it("returns ReloadRollbackFailed when both reload calls throw", async () => {
    const running = makeFakeRunning();
    running.hooks[0] = async () => {
      throw new Error("commit-boom");
    };
    running.hooks[1] = async () => {
      throw new Error("rollback-boom");
    };
    const plan = makePlan();
    const result = await commitReload(running, plan, makeRuntime(), makeConfig());
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("ReloadRollbackFailed");
    if (result.error._tag !== "ReloadRollbackFailed") return;
    expect(result.error.originalCause).toContain("commit-boom");
    expect(result.error.rollbackCause).toContain("rollback-boom");
    expect(running.reloadCalls).toBe(2);
  });
});

// ── Rev 2 P1 #3 sub-table: SIGTERM + ReloadRollbackFailed precedence ─

describe("installBridgeProcessLifecycle: signal-wins-over-rollback-failure (rev 2 P1 #3)", () => {
  let tempHome: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "zapbot-bp-rollback-"));
    mkdirSync(join(tempHome, ".zapbot"), { recursive: true });
    writeFileSync(
      join(tempHome, ".zapbot", "config.json"),
      JSON.stringify({ webhookSecret: "wh-secret", apiKey: "api-key" }),
    );
    env = { HOME: tempHome, ZAPBOT_BOT_USERNAME: "test-bot" };
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("SIGTERM during Reloading + ReloadRollbackFailed → ShuttingDown(Signal), exit 0", async () => {
    const { deps, fakeProcess, exitTrap } = makeDeps({ env });
    const lifecycle = installBridgeProcessLifecycle(deps);
    try {
      const running = makeFakeRunning();
      let releaseCommit!: () => void;
      const commitGate = new Promise<void>((r) => {
        releaseCommit = r;
      });
      // First reload (commit) blocks until SIGTERM has been recorded; then throws.
      running.hooks[0] = async () => {
        await commitGate;
        throw new Error("commit-boom");
      };
      // Second reload (rollback) also throws — triggers ReloadRollbackFailed.
      running.hooks[1] = async () => {
        throw new Error("rollback-boom");
      };
      lifecycle.markReady(running, makeRuntime());

      fakeProcess.fire("SIGHUP");
      // Wait until lifecycle is mid-reload.
      await new Promise((r) => setTimeout(r, 30));
      expect(lifecycle.state()._tag).toBe("Reloading");

      // SIGTERM arrives during Reloading. Per rev 2 P1 #3, signal wins
      // over the §6.2 force-shutdown that ReloadRollbackFailed would
      // otherwise drive.
      fakeProcess.fire("SIGTERM");

      releaseCommit();
      const code = await exitTrap.next();
      expect(code).toBe(0); // Signal beats Manual.
      const s = lifecycle.state();
      expect(s._tag).toBe("ShuttingDown");
      if (s._tag !== "ShuttingDown") return;
      expect(s.reason._tag).toBe("Signal");
    } finally {
      lifecycle.dispose();
    }
  });

  it("ReloadRollbackFailed without pending signal → ShuttingDown(Manual), exit 1 (§6.2 default)", async () => {
    const { deps, fakeProcess, exitTrap } = makeDeps({ env });
    const lifecycle = installBridgeProcessLifecycle(deps);
    try {
      const running = makeFakeRunning();
      running.hooks[0] = async () => {
        throw new Error("commit-boom");
      };
      running.hooks[1] = async () => {
        throw new Error("rollback-boom");
      };
      lifecycle.markReady(running, makeRuntime());

      fakeProcess.fire("SIGHUP");
      const code = await exitTrap.next();
      expect(code).toBe(1);
      const s = lifecycle.state();
      expect(s._tag).toBe("ShuttingDown");
      if (s._tag !== "ShuttingDown") return;
      expect(s.reason._tag).toBe("Manual");
    } finally {
      lifecycle.dispose();
    }
  });
});

// ── markReady idempotency + liveRuntime read-through ──────────────

describe("BridgeProcessLifecycle handle", () => {
  it("markReady transitions Booting → Ready exactly once", () => {
    const { deps } = makeDeps();
    const lifecycle: BridgeProcessLifecycle = installBridgeProcessLifecycle(deps);
    try {
      const r1 = makeFakeRunning();
      const rt1 = makeRuntime();
      lifecycle.markReady(r1, rt1);
      expect(lifecycle.state()._tag).toBe("Ready");
      expect(lifecycle.liveRuntime()).toBe(rt1);

      // Second call must be a no-op (state machine guards it).
      const rt2 = makeRuntime({ port: 9999 });
      lifecycle.markReady(makeFakeRunning(), rt2);
      expect(lifecycle.liveRuntime()).toBe(rt1);
    } finally {
      lifecycle.dispose();
    }
  });

  it("liveRuntime returns null while in Booting", () => {
    const { deps } = makeDeps();
    const lifecycle = installBridgeProcessLifecycle(deps);
    try {
      expect(lifecycle.liveRuntime()).toBeNull();
    } finally {
      lifecycle.dispose();
    }
  });

  it("requestShutdown is idempotent (repeated calls do not double-exit)", async () => {
    const { deps, exitTrap } = makeDeps();
    const lifecycle = installBridgeProcessLifecycle(deps);
    try {
      const running = makeFakeRunning();
      lifecycle.markReady(running, makeRuntime());
      await Promise.all([
        lifecycle.requestShutdown({ _tag: "Manual", reason: "test" }),
        lifecycle.requestShutdown({ _tag: "Manual", reason: "test" }),
      ]);
      expect(exitTrap.exitCalls).toEqual([1]);
      expect(running.stopCalls).toBe(1);
    } finally {
      lifecycle.dispose();
    }
  });

  it("dispose detaches all signal handlers", () => {
    const { deps, fakeProcess } = makeDeps();
    const lifecycle = installBridgeProcessLifecycle(deps);
    expect(fakeProcess.listenerCount("SIGHUP")).toBe(1);
    lifecycle.dispose();
    expect(fakeProcess.listenerCount("SIGHUP")).toBe(0);
    expect(fakeProcess.listenerCount("SIGINT")).toBe(0);
    expect(fakeProcess.listenerCount("SIGTERM")).toBe(0);
  });
});
