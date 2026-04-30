/**
 * Tests for orchestrator/server.ts.
 *
 * Coverage:
 *   - GET /healthz — 200 ok with port + projects count.
 *   - POST /turn — 200 Replied happy path through fake runner deps.
 *   - POST /turn — 401 when auth header missing.
 *   - POST /turn — 401 when secret mismatches.
 *   - POST /turn — 422 when body is not a valid TurnRequest.
 *   - POST /spawn — 503 FleetSpawnFailed surfaces correctly.
 *   - GET /unknown — 404.
 *   - renderErrorResponse: status code mapping per OrchestratorError tag.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  AUTH_HEADER_PREFIX,
  asHttpPort,
  asSharedSecret,
  renderErrorResponse,
  startOrchestratorServer,
  type HttpServerHandle,
  type ServerDeps,
} from "../src/orchestrator/server.ts";
import {
  asClaudeSessionId,
  type ClaudeSpawnArgs,
  type ProjectLock,
  type RunnerDeps,
  type TurnResponse,
} from "../src/orchestrator/runner.ts";
import type {
  SpawnBrokerHandle,
  SpawnWorkerRequest,
  SpawnWorkerResponse,
} from "../src/orchestrator/spawn-broker.ts";
import type { OrchestratorError } from "../src/orchestrator/errors.ts";

const SECRET = "test-secret-1234567890";

interface TurnRunner {
  result: TurnResponse | { readonly error: OrchestratorError };
  calls: number;
}

interface SpawnRunner {
  result: SpawnWorkerResponse | { readonly error: OrchestratorError };
  calls: number;
}

function makeRunnerDeps(turn: TurnRunner): RunnerDeps {
  return {
    spawnClaude: (_args: ClaudeSpawnArgs) =>
      Effect.gen(function* () {
        turn.calls += 1;
        if ("error" in turn.result) {
          return yield* Effect.fail<OrchestratorError>(turn.result.error);
        }
        const result = turn.result;
        if (result._tag !== "Replied") {
          return yield* Effect.fail<OrchestratorError>({
            _tag: "LeadProcessFailed",
            projectSlug: "test",
            exitCode: 0,
            stderrTail: "unexpected-non-replied",
          });
        }
        return {
          exitCode: 0,
          newSessionId: result.newSessionId,
          stderrTail: "",
        };
      }),
    readSessionFile: () => Effect.succeed(null),
    writeSessionFile: () => Effect.void,
    stashCorruptSession: () => Effect.void,
    acquireProjectLock: () =>
      Effect.succeed<ProjectLock>({ release: () => Effect.void }),
    gitFetch: () => Effect.void,
    provisionCheckout: () => Effect.void,
    writeMcpConfig: () => Effect.void,
    clock: () => 1_000_000,
    log: () => undefined,
    projectsRoot: "/p",
    clonesRoot: "/c",
    lockWaitMs: 30_000,
    orchestratorUrl: "http://127.0.0.1:0",
    orchestratorSecret: "secret",
    spawnMcpBinPath: "/abs/path",
  };
}

function makeBroker(spawn: SpawnRunner): SpawnBrokerHandle {
  return {
    requestWorkerSpawn: (_req: SpawnWorkerRequest) =>
      Effect.gen(function* () {
        spawn.calls += 1;
        if ("error" in spawn.result) {
          return yield* Effect.fail<OrchestratorError>(spawn.result.error);
        }
        return spawn.result;
      }),
    stopAll: () => Effect.void,
    listAgents: () => [],
  };
}

interface TestHarness {
  readonly handle: HttpServerHandle;
  readonly turn: TurnRunner;
  readonly spawn: SpawnRunner;
  readonly baseUrl: string;
}

async function startTestServer(
  turnResult: TurnRunner["result"],
  spawnResult: SpawnRunner["result"],
): Promise<TestHarness> {
  const turn: TurnRunner = { result: turnResult, calls: 0 };
  const spawn: SpawnRunner = { result: spawnResult, calls: 0 };
  const deps: ServerDeps = {
    secret: asSharedSecret(SECRET),
    port: asHttpPort(0),
    runnerDeps: makeRunnerDeps(turn),
    broker: makeBroker(spawn),
    projectsCount: () => 2,
    log: () => undefined,
  };

  const handle = await Effect.runPromise(startOrchestratorServer(deps));
  return {
    handle,
    turn,
    spawn,
    baseUrl: `http://127.0.0.1:${handle.port}`,
  };
}

describe("server endpoints", () => {
  let harness: TestHarness;

  afterEach(async () => {
    if (harness !== undefined) {
      await Effect.runPromise(harness.handle.close());
    }
  });

  it("GET /healthz returns 200 + ok payload", async () => {
    harness = await startTestServer(
      {
        _tag: "Replied",
        newSessionId: asClaudeSessionId("ignored"),
        durationMs: 0,
      },
      { _tag: "Spawned", agentId: "a" as SpawnWorkerResponse["agentId"], worktreePath: "/x" },
    );

    const res = await fetch(`${harness.baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; projects: number };
    expect(body.ok).toBe(true);
    expect(body.projects).toBe(2);
  });

  it("POST /turn returns 200 Replied with valid auth + body", async () => {
    harness = await startTestServer(
      {
        _tag: "Replied",
        newSessionId: asClaudeSessionId("sess-1"),
        durationMs: 0,
      },
      { _tag: "Spawned", agentId: "a" as SpawnWorkerResponse["agentId"], worktreePath: "/x" },
    );

    const res = await fetch(`${harness.baseUrl}/turn`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `${AUTH_HEADER_PREFIX}${SECRET}`,
      },
      body: JSON.stringify({
        projectSlug: "acme-app",
        deliveryId: "delivery-1",
        message: "hi",
        githubToken: "ghs_xxx",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tag: string; newSessionId: string };
    expect(body.tag).toBe("Replied");
    expect(body.newSessionId).toBe("sess-1");
  });

  it("POST /turn returns 401 when auth header is missing", async () => {
    harness = await startTestServer(
      {
        _tag: "Replied",
        newSessionId: asClaudeSessionId("never"),
        durationMs: 0,
      },
      { _tag: "Spawned", agentId: "a" as SpawnWorkerResponse["agentId"], worktreePath: "/x" },
    );

    const res = await fetch(`${harness.baseUrl}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.error).toBe("OrchestratorAuthFailed");
    expect(body.reason).toBe("missing-header");
  });

  it("POST /turn returns 401 when secret mismatches", async () => {
    harness = await startTestServer(
      {
        _tag: "Replied",
        newSessionId: asClaudeSessionId("never"),
        durationMs: 0,
      },
      { _tag: "Spawned", agentId: "a" as SpawnWorkerResponse["agentId"], worktreePath: "/x" },
    );

    const res = await fetch(`${harness.baseUrl}/turn`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `${AUTH_HEADER_PREFIX}wrong`,
      },
      body: JSON.stringify({
        projectSlug: "acme",
        deliveryId: "1",
        message: "x",
        githubToken: "ghs_x",
      }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe("secret-mismatch");
  });

  it("POST /turn returns 422 when body fails schema decode", async () => {
    harness = await startTestServer(
      {
        _tag: "Replied",
        newSessionId: asClaudeSessionId("never"),
        durationMs: 0,
      },
      { _tag: "Spawned", agentId: "a" as SpawnWorkerResponse["agentId"], worktreePath: "/x" },
    );

    const res = await fetch(`${harness.baseUrl}/turn`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `${AUTH_HEADER_PREFIX}${SECRET}`,
      },
      body: JSON.stringify({ projectSlug: "" }),
    });
    expect(res.status).toBe(422);
  });

  it("POST /spawn returns 503 FleetSpawnFailed when broker fails", async () => {
    harness = await startTestServer(
      {
        _tag: "Replied",
        newSessionId: asClaudeSessionId("never"),
        durationMs: 0,
      },
      {
        error: {
          _tag: "FleetSpawnFailed",
          agentName: "agent-x",
          cause: "ready-timeout",
          detail: "1500ms",
        },
      },
    );

    const res = await fetch(`${harness.baseUrl}/spawn`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `${AUTH_HEADER_PREFIX}${SECRET}`,
      },
      body: JSON.stringify({
        repo: "owner/name",
        issue: 1,
        prompt: "do",
        workerSlug: "x",
        githubToken: "ghs_x",
        worktreePath: "/tmp/x",
      }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; cause: string };
    expect(body.error).toBe("FleetSpawnFailed");
    expect(body.cause).toBe("ready-timeout");
  });

  it("GET /not-a-route returns 404", async () => {
    harness = await startTestServer(
      {
        _tag: "Replied",
        newSessionId: asClaudeSessionId("never"),
        durationMs: 0,
      },
      { _tag: "Spawned", agentId: "a" as SpawnWorkerResponse["agentId"], worktreePath: "/x" },
    );

    const res = await fetch(`${harness.baseUrl}/elsewhere`);
    expect(res.status).toBe(404);
  });
});

describe("renderErrorResponse", () => {
  it("maps every OrchestratorError tag to a status + JSON body", () => {
    const cases: ReadonlyArray<{ readonly error: OrchestratorError; readonly status: number }> = [
      {
        error: { _tag: "OrchestratorAuthFailed", reason: "missing-header" },
        status: 401,
      },
      { error: { _tag: "TurnRequestInvalid", reason: "bad" }, status: 422 },
      { error: { _tag: "SpawnRequestInvalid", reason: "bad" }, status: 422 },
      { error: { _tag: "LockTimeout", projectSlug: "a", waitedMs: 100 }, status: 429 },
      {
        error: {
          _tag: "LeadSessionCorrupted",
          projectSlug: "a",
          sessionPath: "/x",
          reason: "y",
        },
        status: 503,
      },
      {
        error: {
          _tag: "LeadProcessFailed",
          projectSlug: "a",
          exitCode: 1,
          stderrTail: "x",
        },
        status: 503,
      },
      {
        error: {
          _tag: "FleetSpawnFailed",
          agentName: "a",
          cause: "ready-timeout",
          detail: "x",
        },
        status: 503,
      },
      { error: { _tag: "ProjectDirMissing", projectSlug: "a", path: "/x" }, status: 503 },
      { error: { _tag: "GitFetchFailed", projectSlug: "a", stderrTail: "x" }, status: 503 },
      {
        error: {
          _tag: "ProjectCheckoutFailed",
          projectSlug: "a",
          stage: "clone",
          stderrTail: "x",
        },
        status: 503,
      },
      {
        error: {
          _tag: "McpConfigWriteFailed",
          projectSlug: "a",
          path: "/x",
          cause: "y",
        },
        status: 503,
      },
      {
        error: { _tag: "OrchestratorUnreachable", url: "http://x", cause: "y" },
        status: 503,
      },
    ];

    for (const c of cases) {
      const { status, body } = renderErrorResponse(c.error);
      expect(status).toBe(c.status);
      expect(body.error).toBe(c.error._tag);
    }
  });
});

beforeEach(() => {
  /* no-op — vitest requires the import for the timer hooks. */
});
