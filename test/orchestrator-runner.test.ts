/**
 * Tests for orchestrator/runner.ts.
 *
 * Coverage:
 *   - runTurn: fresh project — no session.json on disk; spawnClaude is
 *     invoked with resumeSessionId=null; new session.json is persisted.
 *   - runTurn: resume — existing session.json read; spawnClaude is
 *     invoked with the prior session id.
 *   - runTurn: deduplicates a redelivered webhook (same deliveryId)
 *     and returns DuplicateDelivery without invoking spawnClaude.
 *   - runTurn: corrupt session.json triggers stash + LeadSessionCorrupted.
 *   - runTurn: lock acquisition timeout → LockTimeout.
 *   - runTurn: claude exits non-zero → LeadProcessFailed.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  asClaudeSessionId,
  asProjectSlug,
  loadSessionState,
  persistSessionState,
  runTurn,
  type ClaudeSessionId,
  type ClaudeSpawnArgs,
  type ProjectLock,
  type RunnerDeps,
  type SessionState,
  type TurnRequest,
} from "../src/orchestrator/runner.ts";
import { asDeliveryId } from "../src/types.ts";
import type { OrchestratorError } from "../src/orchestrator/errors.ts";

interface FakeFs {
  readonly files: Map<string, string>;
  readonly stashed: Set<string>;
  readonly mcpWrites: Set<string>;
}

interface FakeSpawnLog {
  readonly calls: Array<{
    readonly resumeSessionId: ClaudeSessionId | null;
    readonly message: string;
    readonly cwd: string;
  }>;
  result: {
    readonly exitCode: number;
    readonly newSessionId: ClaudeSessionId | null;
    readonly stderrTail: string;
  };
}

function makeRunnerDeps(
  fs: FakeFs,
  spawnLog: FakeSpawnLog,
  overrides: Partial<RunnerDeps> = {},
): RunnerDeps {
  let now = 1_000_000;
  return {
    spawnClaude: (args: ClaudeSpawnArgs) =>
      Effect.sync(() => {
        spawnLog.calls.push({
          resumeSessionId: args.resumeSessionId,
          message: args.message,
          cwd: args.cwd,
        });
        return spawnLog.result;
      }),
    readSessionFile: (filePath: string) =>
      Effect.sync(() => fs.files.get(filePath) ?? null),
    writeSessionFile: (filePath: string, body: string) =>
      Effect.sync(() => {
        fs.files.set(filePath, body);
      }),
    stashCorruptSession: (filePath: string, nowMs: number) =>
      Effect.sync(() => {
        if (fs.files.has(filePath)) {
          fs.stashed.add(`${filePath}.corrupt-${nowMs}`);
          fs.files.delete(filePath);
        }
      }),
    acquireProjectLock: (_lockPath: string, _waitMs: number) =>
      Effect.succeed<ProjectLock>({ release: () => Effect.void }),
    gitFetch: () => Effect.void,
    provisionCheckout: () => Effect.void,
    writeMcpConfig: (filePath: string, _body: string) =>
      Effect.sync(() => {
        fs.mcpWrites.add(filePath);
      }),
    clock: () => {
      now += 100;
      return now;
    },
    log: () => undefined,
    projectsRoot: "/p",
    clonesRoot: "/c",
    lockWaitMs: 30_000,
    orchestratorUrl: "http://127.0.0.1:3002",
    orchestratorSecret: "secret",
    spawnMcpBinPath: "/abs/path/to/zapbot-spawn-mcp.ts",
    ...overrides,
  };
}

const PROJECT = asProjectSlug("acme-app");

function makeRequest(deliveryId = "delivery-1", message = "hi"): TurnRequest {
  return {
    projectSlug: PROJECT,
    deliveryId: asDeliveryId(deliveryId),
    message,
    githubToken: "ghs_xxx" as TurnRequest["githubToken"],
  };
}

describe("runTurn", () => {
  it("fresh project: spawns claude without --resume and persists new session id", async () => {
    const fs: FakeFs = {
      files: new Map(),
      stashed: new Set(),
      mcpWrites: new Set(),
    };
    const spawnLog: FakeSpawnLog = {
      calls: [],
      result: {
        exitCode: 0,
        newSessionId: asClaudeSessionId("sess-fresh"),
        stderrTail: "",
      },
    };
    const deps = makeRunnerDeps(fs, spawnLog);

    const response = await Effect.runPromise(runTurn(makeRequest(), deps));
    expect(response._tag).toBe("Replied");
    if (response._tag !== "Replied") return;
    expect(response.newSessionId).toBe("sess-fresh");
    expect(spawnLog.calls.length).toBe(1);
    expect(spawnLog.calls[0].resumeSessionId).toBeNull();
    expect(fs.files.get("/p/acme-app/session.json")).toContain("sess-fresh");
  });

  it("resume: reads existing session.json and passes id to spawnClaude", async () => {
    const fs: FakeFs = {
      files: new Map([
        [
          "/p/acme-app/session.json",
          JSON.stringify({
            currentSessionId: "sess-prior",
            lastTurnAt: 100,
            lastDeliveryId: "delivery-prior",
          }),
        ],
      ]),
      stashed: new Set(),
      mcpWrites: new Set(),
    };
    const spawnLog: FakeSpawnLog = {
      calls: [],
      result: {
        exitCode: 0,
        newSessionId: asClaudeSessionId("sess-next"),
        stderrTail: "",
      },
    };
    const deps = makeRunnerDeps(fs, spawnLog);

    const response = await Effect.runPromise(runTurn(makeRequest("delivery-2"), deps));
    expect(response._tag).toBe("Replied");
    expect(spawnLog.calls.length).toBe(1);
    expect(spawnLog.calls[0].resumeSessionId).toBe("sess-prior");
  });

  it("dedup: returns DuplicateDelivery when deliveryId matches lastDeliveryId", async () => {
    const fs: FakeFs = {
      files: new Map([
        [
          "/p/acme-app/session.json",
          JSON.stringify({
            currentSessionId: "sess-1",
            lastTurnAt: 100,
            lastDeliveryId: "delivery-1",
          }),
        ],
      ]),
      stashed: new Set(),
      mcpWrites: new Set(),
    };
    const spawnLog: FakeSpawnLog = {
      calls: [],
      result: {
        exitCode: 0,
        newSessionId: asClaudeSessionId("never"),
        stderrTail: "",
      },
    };
    const deps = makeRunnerDeps(fs, spawnLog);

    const response = await Effect.runPromise(runTurn(makeRequest("delivery-1"), deps));
    expect(response._tag).toBe("DuplicateDelivery");
    if (response._tag !== "DuplicateDelivery") return;
    expect(response.priorSessionId).toBe("sess-1");
    expect(spawnLog.calls.length).toBe(0);
  });

  it("corrupt session.json: stashes file and fails LeadSessionCorrupted", async () => {
    const fs: FakeFs = {
      files: new Map([["/p/acme-app/session.json", "{not valid json"]]),
      stashed: new Set(),
      mcpWrites: new Set(),
    };
    const spawnLog: FakeSpawnLog = {
      calls: [],
      result: {
        exitCode: 0,
        newSessionId: asClaudeSessionId("never"),
        stderrTail: "",
      },
    };
    const deps = makeRunnerDeps(fs, spawnLog);

    const exit = await Effect.runPromiseExit(runTurn(makeRequest(), deps));
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    const failure = exit.cause as { readonly _tag?: string; readonly error?: unknown };
    const error = failure.error as OrchestratorError;
    expect(error._tag).toBe("LeadSessionCorrupted");
    expect(fs.files.has("/p/acme-app/session.json")).toBe(false);
    expect(Array.from(fs.stashed).some((p) => p.startsWith("/p/acme-app/session.json.corrupt-"))).toBe(true);
  });

  it("lock timeout: surfaces as LockTimeout", async () => {
    const fs: FakeFs = {
      files: new Map(),
      stashed: new Set(),
      mcpWrites: new Set(),
    };
    const spawnLog: FakeSpawnLog = {
      calls: [],
      result: {
        exitCode: 0,
        newSessionId: asClaudeSessionId("never"),
        stderrTail: "",
      },
    };
    const deps = makeRunnerDeps(fs, spawnLog, {
      acquireProjectLock: (_lockPath: string, waitMs: number) =>
        Effect.fail<OrchestratorError>({
          _tag: "LockTimeout",
          projectSlug: "acme-app",
          waitedMs: waitMs,
        }),
    });

    const exit = await Effect.runPromiseExit(runTurn(makeRequest(), deps));
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    const failure = exit.cause as { readonly _tag?: string; readonly error?: unknown };
    const error = failure.error as OrchestratorError;
    expect(error._tag).toBe("LockTimeout");
  });

  it("non-zero exit: surfaces as LeadProcessFailed", async () => {
    const fs: FakeFs = {
      files: new Map(),
      stashed: new Set(),
      mcpWrites: new Set(),
    };
    const spawnLog: FakeSpawnLog = {
      calls: [],
      result: { exitCode: 2, newSessionId: null, stderrTail: "boom" },
    };
    const deps = makeRunnerDeps(fs, spawnLog);

    const exit = await Effect.runPromiseExit(runTurn(makeRequest(), deps));
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    const failure = exit.cause as { readonly _tag?: string; readonly error?: unknown };
    const error = failure.error as { readonly _tag: string; readonly stderrTail: string };
    expect(error._tag).toBe("LeadProcessFailed");
    expect(error.stderrTail).toBe("boom");
  });
});

describe("loadSessionState / persistSessionState", () => {
  it("returns synthetic empty state when session.json is absent", async () => {
    const fs: FakeFs = {
      files: new Map(),
      stashed: new Set(),
      mcpWrites: new Set(),
    };
    const deps = makeRunnerDeps(fs, {
      calls: [],
      result: { exitCode: 0, newSessionId: null, stderrTail: "" },
    });

    const state = await Effect.runPromise(loadSessionState(PROJECT, deps));
    expect(state.currentSessionId).toBeNull();
    expect(state.lastDeliveryId).toBeNull();
    expect(state.lastTurnAt).toBe(0);
  });

  it("round-trips state via persistSessionState + loadSessionState", async () => {
    const fs: FakeFs = {
      files: new Map(),
      stashed: new Set(),
      mcpWrites: new Set(),
    };
    const deps = makeRunnerDeps(fs, {
      calls: [],
      result: { exitCode: 0, newSessionId: null, stderrTail: "" },
    });

    const state: SessionState = {
      currentSessionId: asClaudeSessionId("sess-x"),
      lastTurnAt: 42,
      lastDeliveryId: asDeliveryId("delivery-x"),
    };
    await Effect.runPromise(persistSessionState(PROJECT, state, deps));
    const reloaded = await Effect.runPromise(loadSessionState(PROJECT, deps));
    expect(reloaded.currentSessionId).toBe("sess-x");
    expect(reloaded.lastDeliveryId).toBe("delivery-x");
    expect(reloaded.lastTurnAt).toBe(42);
  });
});
