/**
 * orchestrator/spawn-broker — Effect-native wrapper around
 * `@moltzap/runtimes.startRuntimeAgent` that translates an MCP-tool
 * `request_worker_spawn` call into a worker subprocess (Claude Code via
 * `ClaudeCodeAdapter`) and tracks the resulting fleet for shutdown.
 *
 * Owns: the SpawnBroker handle (per orchestrator process; one fleet),
 * the SpawnWorkerRequest / SpawnWorkerResponse schema-decoded shapes,
 * the stub `RuntimeServerHandle` used until upstream WS-presence
 * subscription lands and sub-issue #8 swaps the stub for the real
 * implementation.
 *
 * Does not own: HTTP transport (server.ts), MCP transport
 * (bin/zapbot-spawn-mcp.ts), claude-runner subprocess (runner.ts), or
 * worktree provisioning beyond passing the worktree path to the adapter
 * (the runner pre-creates the worktree before calling the broker).
 *
 * Note on stub design: the architect's design doc § 3 described the
 * stub for the pre-refactor `RuntimeServerHandle.connections.getByAgent`
 * shape. The submodule pin used here (b218de7) carries the post-refactor
 * `awaitAgentReady(agentId, timeoutMs)` API, so the stub implements that
 * method directly with a deterministic delay-then-Ready pattern. The
 * failure-mode analysis from the design doc still applies: no real auth
 * verification, no agent-side auth-failure detection. Sub-issue #8 lands
 * the WS-presence-backed implementation.
 */

import { Effect } from "effect";
import {
  startRuntimeAgent,
  type ReadyOutcome,
  type RuntimeFleetAgent,
  type RuntimeServerHandle,
  type Runtime,
} from "@moltzap/runtimes";
import type { RepoFullName } from "../types.ts";
import type { OrchestratorError } from "./errors.ts";

// ── Branded identifiers ─────────────────────────────────────────────

export type AgentId = string & { readonly __brand: "AgentId" };
export type GithubInstallationToken = string & {
  readonly __brand: "GithubInstallationToken";
};

// ── Public shapes ───────────────────────────────────────────────────

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

export interface SpawnBrokerHandle {
  readonly requestWorkerSpawn: (
    request: SpawnWorkerRequest,
  ) => Effect.Effect<SpawnWorkerResponse, OrchestratorError, never>;
  readonly stopAll: () => Effect.Effect<void, never, never>;
  /** Snapshot of currently-tracked agents (used by /healthz and tests). */
  readonly listAgents: () => ReadonlyArray<RuntimeFleetAgent>;
}

// ── DI seam ─────────────────────────────────────────────────────────

export interface SpawnBrokerDeps {
  readonly server: RuntimeServerHandle;
  readonly clock: () => number;
  readonly randomHex: (bytes: number) => string;
  readonly log: (
    level: "info" | "warn" | "error",
    msg: string,
    extra?: Record<string, unknown>,
  ) => void;
  readonly claudeBin: string;
  readonly channelDistDir: string;
  readonly moltzapRepoRoot: string;
  /** moltzap-server URL the worker should authenticate against. */
  readonly moltzapServerUrl: string;
  /** moltzap api key minted for the worker; same key is supplied to the runtime spec. */
  readonly moltzapApiKey: string;
  readonly readyTimeoutMs: number;
  /**
   * Optional override for `startRuntimeAgent`. Tests pass a stub that
   * returns a hand-built `Runtime` so the broker exercises the
   * Effect/error wiring without spawning a real claude process.
   */
  readonly startRuntimeAgent?: typeof startRuntimeAgent;
}

// ── Stub RuntimeServerHandle ────────────────────────────────────────

/**
 * Stub `RuntimeServerHandle.awaitAgentReady` used until the WS-presence-
 * backed implementation lands (sub-issue #8). Resolves Ready after
 * `fakeReadyDelayMs` from the first call for a given agentId, and
 * sticks Ready for subsequent calls. Returns Timeout if `timeoutMs`
 * expires before the delay elapses.
 *
 * Limitations (mirrors design doc § 3):
 *   - no real auth verification
 *   - no agent-side auth-failure detection
 *   - the delay is heuristic
 * Adapter-layer `pollExitCode` still surfaces a crashing process as
 * `ProcessExited` because the adapter races `awaitAgentReady` against
 * its own exit poll.
 */
export function createStubRuntimeServerHandle(deps: {
  readonly clock: () => number;
  readonly fakeReadyDelayMs: number;
}): RuntimeServerHandle {
  const firstSeenAt = new Map<string, number>();
  return {
    awaitAgentReady(
      agentId: string,
      timeoutMs: number,
    ): Effect.Effect<ReadyOutcome, never, never> {
      return Effect.suspend(() => {
        const now = deps.clock();
        const seenAt = firstSeenAt.get(agentId);
        if (seenAt === undefined) {
          firstSeenAt.set(agentId, now);
        }
        const baseline = seenAt ?? now;
        const elapsed = now - baseline;
        const remaining = Math.max(0, deps.fakeReadyDelayMs - elapsed);
        if (timeoutMs < remaining) {
          return Effect.succeed<ReadyOutcome>({
            _tag: "Timeout",
            timeoutMs,
          });
        }
        return Effect.sleep(`${remaining} millis`).pipe(
          Effect.zipRight(Effect.succeed<ReadyOutcome>({ _tag: "Ready" })),
        );
      });
    },
  };
}

// ── Workspace seeding ───────────────────────────────────────────────

/**
 * Project the SpawnWorkerRequest into the workspace files the
 * ClaudeCodeAdapter copies into the per-agent state dir under
 * `<stateDir>/workspace/`. The worker reads `TASK.md` for prompt +
 * issue context and `.env` for `GH_TOKEN`. ClaudeCodeAdapter forwards
 * `--add-dir <stateDir>/workspace` to the claude CLI so these files
 * are visible to the worker.
 *
 * Worktree binding (architect doc § 7 vs. reality): the design doc
 * specifies one git worktree per spawned worker at
 * `~/.zapbot/projects/<slug>/workers/<workerSlug>/`. ClaudeCodeAdapter
 * does not currently bind to an external worktree — it allocates its
 * own `mkdtempSync` state dir for each spawn. We do NOT materialize
 * the worktree here and we do NOT direct the worker to `cd` into a
 * path the adapter has not bound. The `worktreePath` field stays on
 * the wire (the lead session passes whatever value it computed) but
 * is informational only until upstream `ClaudeCodeAdapter` grows a
 * `cwd`/`worktreePath` option (out-of-scope sub-issue). When it does,
 * a follow-up swaps in adapter binding + worktree provisioning at
 * the same time.
 *
 * The token rides `.env` rather than being inlined in `TASK.md` so
 * `TASK.md` stays scrubbable in logs without leaking installation
 * tokens.
 */
function renderWorkspaceFiles(
  request: SpawnWorkerRequest,
): ReadonlyArray<{ readonly relativePath: string; readonly content: string }> {
  const taskBody = [
    `# Worker task — ${request.workerSlug}`,
    "",
    `repo: ${request.repo}`,
    `issue: ${request.issue ?? "(none)"}`,
    `worktreePath (informational): ${request.worktreePath}`,
    "",
    "## Instructions",
    "",
    request.prompt,
    "",
    "## Tooling",
    "",
    "- `gh` is authenticated via `$GH_TOKEN` in the environment block.",
    "- The worker runs in the adapter's allocated state dir; the",
    "  worktree path above is recorded for reference, not bound as cwd.",
    "",
  ].join("\n");

  const envBody = `GH_TOKEN=${request.githubToken}\n`;

  return [
    { relativePath: "TASK.md", content: taskBody },
    { relativePath: ".env", content: envBody },
  ];
}

// ── Spawn record (forward-compat seam) ──────────────────────────────

interface SpawnRecord {
  readonly agentId: AgentId;
  readonly workerSlug: string;
  readonly worktreePath: string;
  readonly startedAt: number;
  readonly runtime: Runtime;
}

// ── Constructor ─────────────────────────────────────────────────────

export function createSpawnBroker(deps: SpawnBrokerDeps): SpawnBrokerHandle {
  const records = new Map<AgentId, SpawnRecord>();
  const startAgent = deps.startRuntimeAgent ?? startRuntimeAgent;

  const requestWorkerSpawn = (
    request: SpawnWorkerRequest,
  ): Effect.Effect<SpawnWorkerResponse, OrchestratorError, never> =>
    Effect.gen(function* () {
      // Validate worktree path is non-empty (Schema-decode boundary at the
      // server; defense-in-depth here catches direct in-process callers).
      if (request.worktreePath.length === 0) {
        return yield* Effect.fail<OrchestratorError>({
          _tag: "SpawnRequestInvalid",
          reason: "worktreePath is empty",
        });
      }

      const agentId = (`worker-${request.workerSlug}-${deps.randomHex(8)}`) as AgentId;
      const agentName = `${request.workerSlug}-${request.repo.replace("/", "_")}`;

      deps.log("info", "spawn-broker: starting worker", {
        agentId,
        agentName,
        worktreePath: request.worktreePath,
      });

      // Seed task context into the worker's workspace so the spawned
      // claude has the prompt, GitHub token, and target worktree path
      // available when it boots. ClaudeCodeAdapter creates its own
      // tmpdir for state and copies workspaceFiles in; the lead session
      // continues to send turns over the moltzap channel after spawn.
      const workspaceFiles = renderWorkspaceFiles(request);

      const launch = startAgent({
        kind: "claude-code",
        server: deps.server,
        agent: {
          agentName,
          apiKey: deps.moltzapApiKey,
          agentId,
          serverUrl: deps.moltzapServerUrl,
          workspaceFiles,
        },
        readyTimeoutMs: deps.readyTimeoutMs,
        claudeCode: {
          claudeBin: deps.claudeBin,
          channelDistDir: deps.channelDistDir,
          repoRoot: deps.moltzapRepoRoot,
        },
      });

      const runtime = yield* launch.pipe(
        Effect.mapError((cause): OrchestratorError => {
          const tag = cause._tag;
          if (tag === "RuntimeReadyTimedOut") {
            return {
              _tag: "FleetSpawnFailed",
              agentName,
              cause: "ready-timeout",
              detail: `agent did not become ready within ${deps.readyTimeoutMs}ms`,
            };
          }
          if (tag === "RuntimeExitedBeforeReady") {
            return {
              _tag: "FleetSpawnFailed",
              agentName,
              cause: "process-exited",
              detail: `exit=${cause.exitCode ?? "null"} stderr=${cause.stderr.slice(-200)}`,
            };
          }
          // SpawnFailed
          return {
            _tag: "FleetSpawnFailed",
            agentName,
            cause: "config-invalid",
            detail: cause.cause instanceof Error ? cause.cause.message : String(cause.cause),
          };
        }),
      );

      records.set(agentId, {
        agentId,
        workerSlug: request.workerSlug,
        worktreePath: request.worktreePath,
        startedAt: deps.clock(),
        runtime,
      });

      return {
        _tag: "Spawned" as const,
        agentId,
        worktreePath: request.worktreePath,
      };
    });

  const stopAll = (): Effect.Effect<void, never, never> =>
    Effect.gen(function* () {
      const snapshot = Array.from(records.values()).reverse();
      records.clear();
      yield* Effect.forEach(snapshot, (record) => record.runtime.teardown(), {
        discard: true,
      });
    });

  const listAgents = (): ReadonlyArray<RuntimeFleetAgent> =>
    Array.from(records.values()).map((record) => ({
      name: record.workerSlug,
      agentId: record.agentId,
    }));

  return {
    requestWorkerSpawn,
    stopAll,
    listAgents,
  };
}

