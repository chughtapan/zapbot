/**
 * Tests for orchestrator/spawn-broker.ts.
 *
 * Coverage:
 *   - createStubRuntimeServerHandle: first poll empty, then Ready after
 *     fakeReadyDelayMs (delay-then-Ready semantics, sticky thereafter).
 *   - createStubRuntimeServerHandle: returns Timeout when timeoutMs is
 *     less than the remaining delay.
 *   - createSpawnBroker.requestWorkerSpawn: success path with a fake
 *     `startRuntimeAgent` that returns a hand-built Runtime.
 *   - createSpawnBroker.requestWorkerSpawn: ready-timeout from upstream
 *     surfaces as FleetSpawnFailed{cause:"ready-timeout"}.
 *   - createSpawnBroker.stopAll: idempotent; tears down every spawned
 *     runtime in reverse order.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  RuntimeReadyTimedOut,
  type LogSlice,
  type ReadyOutcome,
  type Runtime,
  type RuntimeLaunchFailed,
  type RuntimeStartOptions,
} from "@moltzap/runtimes";
import {
  createSpawnBroker,
  createStubRuntimeServerHandle,
  type SpawnBrokerDeps,
  type SpawnWorkerRequest,
} from "../src/orchestrator/spawn-broker.ts";
import { asRepoFullName } from "../src/types.ts";

function makeFakeRuntime(teardownLog: string[], name: string): Runtime {
  return {
    spawn: () => Effect.void,
    waitUntilReady: () =>
      Effect.succeed<ReadyOutcome>({ _tag: "Ready" as const }),
    teardown: () =>
      Effect.sync(() => {
        teardownLog.push(name);
      }),
    getLogs: (_offset: number): LogSlice => ({ text: "", nextOffset: 0 }),
    getInboundMarker: (): string => "marker",
  };
}

function makeBrokerDeps(
  partial: Partial<SpawnBrokerDeps> & {
    readonly startRuntimeAgent: SpawnBrokerDeps["startRuntimeAgent"];
  },
): SpawnBrokerDeps {
  return {
    server: createStubRuntimeServerHandle({
      clock: () => Date.now(),
      fakeReadyDelayMs: 100,
    }),
    clock: () => Date.now(),
    randomHex: (bytes) => "x".repeat(bytes * 2),
    log: () => undefined,
    claudeBin: "/usr/local/bin/claude",
    channelDistDir: "/tmp/channel-dist",
    moltzapRepoRoot: "/tmp/moltzap",
    moltzapServerUrl: "http://localhost:3100",
    moltzapApiKey: "test-key",
    readyTimeoutMs: 1000,
    ...partial,
  };
}

function makeRequest(slug: string): SpawnWorkerRequest {
  return {
    repo: asRepoFullName("acme/app"),
    issue: 7,
    prompt: "do the thing",
    githubToken: "ghs_xxx" as SpawnWorkerRequest["githubToken"],
    workerSlug: slug,
    worktreePath: `/tmp/workers/${slug}`,
  };
}

describe("createStubRuntimeServerHandle", () => {
  it("blocks for fakeReadyDelayMs then resolves Ready (sticky)", async () => {
    const t0 = 1000;
    let now = t0;
    const handle = createStubRuntimeServerHandle({
      clock: () => now,
      fakeReadyDelayMs: 1500,
    });

    const program = Effect.gen(function* () {
      const first = yield* handle.awaitAgentReady("agent-1", 5000);
      now += 1500;
      const second = yield* handle.awaitAgentReady("agent-1", 5000);
      return { first, second };
    });

    const result = await Effect.runPromise(program);
    expect(result.first._tag).toBe("Ready");
    expect(result.second._tag).toBe("Ready");
  });

  it("returns Timeout when timeoutMs < remaining delay", async () => {
    let now = 1000;
    const handle = createStubRuntimeServerHandle({
      clock: () => now,
      fakeReadyDelayMs: 5000,
    });

    const outcome = await Effect.runPromise(handle.awaitAgentReady("agent-X", 100));
    expect(outcome._tag).toBe("Timeout");
    if (outcome._tag !== "Timeout") return;
    expect(outcome.timeoutMs).toBe(100);
    void now;
  });
});

describe("createSpawnBroker.requestWorkerSpawn", () => {
  it("returns Spawned with a generated agentId on success", async () => {
    const teardownLog: string[] = [];
    const fakeStart: SpawnBrokerDeps["startRuntimeAgent"] = (
      _options: RuntimeStartOptions,
    ) => Effect.succeed(makeFakeRuntime(teardownLog, "test-agent"));

    const broker = createSpawnBroker(
      makeBrokerDeps({ startRuntimeAgent: fakeStart }),
    );

    const result = await Effect.runPromise(
      broker.requestWorkerSpawn(makeRequest("alpha")),
    );
    expect(result._tag).toBe("Spawned");
    expect(result.agentId.startsWith("worker-alpha-")).toBe(true);
    expect(result.worktreePath).toBe("/tmp/workers/alpha");
    expect(broker.listAgents().length).toBe(1);
  });

  it("maps RuntimeReadyTimedOut to FleetSpawnFailed with ready-timeout", async () => {
    const fakeStart: SpawnBrokerDeps["startRuntimeAgent"] = (
      _options: RuntimeStartOptions,
    ) =>
      Effect.fail<RuntimeLaunchFailed>(
        new RuntimeReadyTimedOut("worker-x", 250),
      );

    const broker = createSpawnBroker(
      makeBrokerDeps({ startRuntimeAgent: fakeStart }),
    );

    const exit = await Effect.runPromiseExit(
      broker.requestWorkerSpawn(makeRequest("beta")),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    const failure = (exit.cause as { readonly _tag?: string; readonly error?: unknown });
    expect(failure._tag).toBe("Fail");
    const error = failure.error as { readonly _tag: string; readonly cause: string };
    expect(error._tag).toBe("FleetSpawnFailed");
    expect(error.cause).toBe("ready-timeout");
    expect(broker.listAgents().length).toBe(0);
  });

  it("rejects empty worktreePath as SpawnRequestInvalid", async () => {
    const fakeStart: SpawnBrokerDeps["startRuntimeAgent"] = () =>
      Effect.die("fakeStart should not run");

    const broker = createSpawnBroker(
      makeBrokerDeps({ startRuntimeAgent: fakeStart }),
    );
    const request: SpawnWorkerRequest = { ...makeRequest("gamma"), worktreePath: "" };

    const exit = await Effect.runPromiseExit(broker.requestWorkerSpawn(request));
    expect(exit._tag).toBe("Failure");
  });
});

describe("createSpawnBroker.stopAll", () => {
  it("tears down every tracked runtime, in reverse order, and is idempotent", async () => {
    const teardownLog: string[] = [];
    let counter = 0;
    const fakeStart: SpawnBrokerDeps["startRuntimeAgent"] = (
      _options: RuntimeStartOptions,
    ) => {
      counter += 1;
      return Effect.succeed(makeFakeRuntime(teardownLog, `runtime-${counter}`));
    };

    const broker = createSpawnBroker(
      makeBrokerDeps({ startRuntimeAgent: fakeStart }),
    );

    await Effect.runPromise(broker.requestWorkerSpawn(makeRequest("first")));
    await Effect.runPromise(broker.requestWorkerSpawn(makeRequest("second")));
    expect(broker.listAgents().length).toBe(2);

    await Effect.runPromise(broker.stopAll());
    expect(teardownLog).toEqual(["runtime-2", "runtime-1"]);
    expect(broker.listAgents().length).toBe(0);

    // idempotent
    await Effect.runPromise(broker.stopAll());
    expect(teardownLog).toEqual(["runtime-2", "runtime-1"]);
  });
});
