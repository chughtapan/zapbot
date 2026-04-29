/**
 * orchestrator/spawn-broker — Effect-native wrapper around
 * `@moltzap/runtimes.startRuntimeAgent` that translates an MCP-tool
 * `request_worker_spawn` call into a worker subprocess (Claude Code via
 * `ClaudeCodeAdapter`) and tracks the resulting fleet for shutdown.
 *
 * Owns: the SpawnBroker handle (per orchestrator process; one fleet),
 * the SpawnWorkerRequest / SpawnWorkerResponse schema-decoded shapes,
 * the stub RuntimeServerHandle ("first poll empty, then auth=fake")
 * that satisfies `claude-code-adapter.ts:waitUntilReady`'s sync poll
 * loop until upstream `awaitAgentReady` (sub-issue #371) lands and
 * sub-issue #8 swaps the stub for the real WS-presence implementation.
 *
 * Does not own: HTTP transport (server.ts), MCP transport
 * (bin/zapbot-spawn-mcp.ts), claude-runner subprocess (runner.ts), or
 * worktree provisioning beyond passing the worktree path to the adapter
 * (the runner pre-creates the worktree before calling the broker).
 */

import { Effect } from "effect";
import type {
  RuntimeConnection,
  RuntimeServerHandle,
} from "@moltzap/runtimes";
import type { RepoFullName } from "../types.ts";
import type { OrchestratorError } from "./errors.ts";

// ── Branded identifiers ─────────────────────────────────────────────

export type AgentId = string & { readonly __brand: "AgentId" };
export type GithubInstallationToken = string & {
  readonly __brand: "GithubInstallationToken";
};

// ── Public shapes ───────────────────────────────────────────────────

/**
 * MCP tool input. Decoded at the bin/zapbot-spawn-mcp.ts boundary; the
 * broker assumes a validated value.
 *
 * `issue` is null for free-form workers (e.g., a long-running indexer).
 * `worktreePath` is the absolute path the runner pre-created for this
 * worker (`~/.zapbot/projects/<slug>/workers/<workerSlug>/`); the broker
 * does NOT create or destroy it.
 */
export interface SpawnWorkerRequest {
  readonly repo: RepoFullName;
  readonly issue: number | null;
  readonly prompt: string;
  readonly githubToken: GithubInstallationToken;
  readonly workerSlug: string;
  readonly worktreePath: string;
}

export interface SpawnWorkerResponse {
  readonly _tag: "Spawned";
  readonly agentId: AgentId;
  readonly worktreePath: string;
}

/**
 * Per-orchestrator-process handle. Holds the moltzap RuntimeFleet so
 * `stopAll` can be called on shutdown. One broker per orchestrator
 * process; agents accumulate across many `requestWorkerSpawn` calls
 * until the orchestrator exits.
 */
export interface SpawnBrokerHandle {
  /**
   * Spawn one worker. Effect resolves with `Spawned` when the runtime
   * adapter's `waitUntilReady` returns Ready. On Timeout / ProcessExited
   * the broker has already torn down the partial spawn; the Effect fails
   * with `FleetSpawnFailed`.
   */
  readonly requestWorkerSpawn: (
    request: SpawnWorkerRequest,
  ) => Effect.Effect<SpawnWorkerResponse, OrchestratorError, never>;

  /**
   * Idempotent. Tears down every spawned agent (SIGTERM → 10s → SIGKILL
   * via the adapter's own `teardown`) and removes per-agent state dirs.
   * Called from the orchestrator entrypoint's SIGINT/SIGTERM handler.
   */
  readonly stopAll: () => Effect.Effect<void, never, never>;
}

// ── DI seam ─────────────────────────────────────────────────────────

/**
 * Dependencies for the spawn broker. Mirrors the dependency-injection
 * shape used by `FixWorkspaceDeps` in the launcher: every effectful
 * primitive the broker needs is named here so tests can substitute
 * deterministic doubles without a process spawn.
 */
export interface SpawnBrokerDeps {
  readonly server: RuntimeServerHandle;
  readonly clock: () => number;
  readonly randomHex: (bytes: number) => string;
  readonly log: (
    level: "info" | "warn" | "error",
    msg: string,
    extra?: Record<string, unknown>,
  ) => void;
  /**
   * Read-only resolved paths the broker hands to the ClaudeCodeAdapter
   * via `claudeCode: { claudeBin, channelDistDir, repoRoot }`. The
   * orchestrator entrypoint resolves these once at boot from the
   * vendored moltzap workspace.
   */
  readonly claudeBin: string;
  readonly channelDistDir: string;
  readonly moltzapRepoRoot: string;
  /** Default ready-timeout for `waitUntilReady`. */
  readonly readyTimeoutMs: number;
}

// ── Stub RuntimeServerHandle ────────────────────────────────────────

/**
 * Stub `RuntimeServerHandle` used until upstream `awaitAgentReady`
 * (sub-issue #371) lands and zapbot sub-issue #8 swaps in the real
 * WS-presence implementation.
 *
 * Pattern ("first poll empty, then auth=fake"): the first
 * `getByAgent(agentId)` call returns `[]`. Subsequent calls within
 * `fakeReadyDelayMs` of the first call also return `[]`. After the
 * delay elapses, `getByAgent` returns a single connection with a
 * non-null `auth` so `claude-code-adapter.waitUntilReady`'s poll loop
 * resolves Ready (it tests `length > 0 && conns[0].auth !== null`).
 *
 * Why this works: the adapter never inspects what `auth` actually
 * contains; it only checks non-null. The polling loop runs at 250 ms
 * intervals, so a `fakeReadyDelayMs` of 1500 ms means roughly six
 * polls return empty before one returns ready. The adapter's
 * separate `pollExitCode` path still detects subprocess crashes
 * before the fake-ready interval elapses, so a worker that crashes
 * on launch still surfaces as `ProcessExited`, not `Ready`.
 *
 * What we lose: no actual auth verification, so a runtime that spawns
 * but never connects to a moltzap server is reported Ready anyway.
 * No detection of agent-side authentication failures (the runtime
 * adapter would normally see a missing/invalid auth and surface it;
 * the stub never sees auth at all). This is acceptable because the
 * lead session is the only consumer of worker output; if a worker
 * silently failed to authenticate, its GitHub-side artifact would
 * never appear and the user retries via `@zapbot`. Sub-issue #8
 * removes the stub once upstream `awaitAgentReady` lands.
 */
export function createStubRuntimeServerHandle(deps: {
  readonly clock: () => number;
  readonly fakeReadyDelayMs: number;
}): RuntimeServerHandle {
  void deps;
  throw new Error("not implemented: createStubRuntimeServerHandle");
}

// Reference imports above are intentional: the implementer threads
// `RuntimeConnection` through the closure returned by
// `createStubRuntimeServerHandle`.
type _StubConnection = RuntimeConnection;
const _stubConnRef: _StubConnection | null = null;
void _stubConnRef;

// ── Constructor ─────────────────────────────────────────────────────

/**
 * Construct a SpawnBrokerHandle bound to the given deps. Holds an
 * internal `RuntimeFleet` (lazily initialized on first
 * `requestWorkerSpawn`) and a `Map<AgentId, SpawnRecord>` so future
 * status-query endpoints (out-of-scope forward-compat seam for
 * worker→lead notifications, epic #369 § "Open architectural questions"
 * Q5) can be added without changing the spawn API.
 */
export function createSpawnBroker(deps: SpawnBrokerDeps): SpawnBrokerHandle {
  void deps;
  throw new Error("not implemented: createSpawnBroker");
}
