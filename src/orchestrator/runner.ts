/**
 * orchestrator/runner — invoke the long-lived per-project Claude Code
 * session for one webhook turn (epic #369 D1, D3).
 *
 * Owns: per-project session-id persistence (`session.json`), the
 * advisory file lock that serializes concurrent webhooks for the same
 * project (epic #369 § "Open architectural questions" Q3), the
 * `claude -p --resume <id> "<message>"` subprocess invocation, and
 * stdout/stderr capture-to-disk (`logs/turn-<deliveryId>.log`).
 *
 * Does not own: HTTP transport (server.ts), worker spawn (spawn-broker.ts),
 * webhook signature verification (bridge), GH_TOKEN minting (bridge), or
 * the project checkout layout (the runner expects `checkout/` to exist;
 * `ensureProjectCheckout` is its own export and is called from the boot
 * path before the first turn).
 */

import { Effect } from "effect";
import type { DeliveryId } from "../types.ts";
import type { OrchestratorError } from "./errors.ts";
import type { GithubInstallationToken } from "./spawn-broker.ts";

// ── Branded identifiers ─────────────────────────────────────────────

export type ProjectSlug = string & { readonly __brand: "ProjectSlug" };
export type ClaudeSessionId = string & { readonly __brand: "ClaudeSessionId" };

// ── Public shapes ───────────────────────────────────────────────────

/**
 * Decoded `POST /turn` body. Mirrored 1:1 to a Schema decoder at the
 * server.ts boundary; the runner assumes a validated value.
 */
export interface TurnRequest {
  readonly projectSlug: ProjectSlug;
  readonly deliveryId: DeliveryId;
  readonly message: string;
  readonly githubToken: GithubInstallationToken;
}

/**
 * Successful outcome of one turn. `Replied` is the dominant case; the
 * other tags expose forward-compat seams for queueing (Q3) and webhook
 * idempotency over GitHub redelivery (epic #369 invariant 3).
 */
export type TurnResponse =
  | {
      readonly _tag: "Replied";
      readonly newSessionId: ClaudeSessionId;
      readonly durationMs: number;
    }
  | {
      readonly _tag: "DuplicateDelivery";
      readonly priorSessionId: ClaudeSessionId;
    };

/**
 * On-disk session record. One per project at
 * `~/.zapbot/projects/<slug>/session.json`. `currentSessionId` is null
 * until the first successful turn writes the id back.
 */
export interface SessionState {
  readonly currentSessionId: ClaudeSessionId | null;
  readonly lastTurnAt: number;
  readonly lastDeliveryId: DeliveryId | null;
}

// ── DI seam ─────────────────────────────────────────────────────────

/**
 * Dependency seam for the runner. Mirrors `FixWorkspaceDeps` in
 * `src/doctor/workspace.ts` (feat/launcher-typescript-port): every
 * effectful primitive is named here so the unit tests can drive
 * runTurn deterministically without touching disk or spawning claude.
 */
export interface RunnerDeps {
  /**
   * Spawn `claude -p --resume <id> "<message>"`. Inherits `GH_TOKEN`
   * (minted by the bridge, threaded through TurnRequest.githubToken)
   * via `env`. The implementation captures stdout/stderr into the
   * per-turn log file before resolving.
   */
  readonly spawnClaude: (
    args: ClaudeSpawnArgs,
  ) => Effect.Effect<ClaudeSpawnResult, OrchestratorError, never>;
  readonly readSessionFile: (
    path: string,
  ) => Effect.Effect<string | null, OrchestratorError, never>;
  readonly writeSessionFile: (
    path: string,
    body: string,
  ) => Effect.Effect<void, OrchestratorError, never>;
  /**
   * Acquire an exclusive advisory file lock at `lockPath`. Resolves
   * with the release function on success. Times out after `waitMs`
   * with `LockTimeout`. Implementation uses `flock(2)` semantics
   * (LOCK_EX | LOCK_NB in a poll loop) so it survives orchestrator
   * crashes via kernel cleanup.
   */
  readonly acquireProjectLock: (
    lockPath: string,
    waitMs: number,
  ) => Effect.Effect<ProjectLock, OrchestratorError, never>;
  readonly clock: () => number;
  readonly log: (
    level: "info" | "warn" | "error",
    msg: string,
    extra?: Record<string, unknown>,
  ) => void;
  /** Root directory for per-project state, e.g. `~/.zapbot/projects`. */
  readonly projectsRoot: string;
  /** Maximum time to wait for the project lock before responding 429. */
  readonly lockWaitMs: number;
}

export interface ClaudeSpawnArgs {
  readonly cwd: string;
  readonly resumeSessionId: ClaudeSessionId | null;
  readonly message: string;
  readonly mcpConfigPath: string;
  readonly env: Readonly<Record<string, string>>;
  readonly logFilePath: string;
}

export interface ClaudeSpawnResult {
  readonly exitCode: number;
  readonly newSessionId: ClaudeSessionId | null;
  readonly stderrTail: string;
}

export interface ProjectLock {
  readonly release: () => Effect.Effect<void, never, never>;
}

// ── Public surface ──────────────────────────────────────────────────

/**
 * Run one webhook turn. Acquires the project lock, reads the current
 * session id, spawns claude with `--resume`, captures the new id,
 * persists it, and releases the lock. Idempotent over webhook
 * redelivery: if the incoming `deliveryId` matches the persisted
 * `lastDeliveryId`, returns `DuplicateDelivery` without re-invoking
 * claude (epic #369 invariant 3).
 *
 * On `LeadSessionCorrupted`: the implementation moves the corrupt
 * `session.json` aside as `session.json.corrupt-<unix-ms>` and fails
 * the Effect; the next turn starts fresh (no `--resume`) and writes
 * a new session id (epic #369 § "Open architectural questions" Q2).
 */
export function runTurn(
  request: TurnRequest,
  deps: RunnerDeps,
): Effect.Effect<TurnResponse, OrchestratorError, never> {
  void request;
  void deps;
  throw new Error("not implemented: runTurn");
}

/**
 * Read `<projectsRoot>/<slug>/session.json`. Returns the decoded
 * SessionState, or a synthetic `{ currentSessionId: null, lastTurnAt: 0,
 * lastDeliveryId: null }` if the file is absent. Fails with
 * `LeadSessionCorrupted` if the file exists but does not decode.
 */
export function loadSessionState(
  projectSlug: ProjectSlug,
  deps: RunnerDeps,
): Effect.Effect<SessionState, OrchestratorError, never> {
  void projectSlug;
  void deps;
  throw new Error("not implemented: loadSessionState");
}

/**
 * Atomically replace `<projectsRoot>/<slug>/session.json` with the
 * given state (write-temp + rename to avoid torn writes).
 */
export function persistSessionState(
  projectSlug: ProjectSlug,
  state: SessionState,
  deps: RunnerDeps,
): Effect.Effect<void, OrchestratorError, never> {
  void projectSlug;
  void state;
  void deps;
  throw new Error("not implemented: persistSessionState");
}

/**
 * Project-checkout strategy (epic #369 § "Open architectural questions"
 * Q1): one bare clone per project at `~/.zapbot/clones/<slug>.git`,
 * one git worktree per project at `~/.zapbot/projects/<slug>/checkout/`,
 * additional worktrees per worker at `~/.zapbot/projects/<slug>/workers/
 * <workerSlug>/`. This function provisions the bare clone (idempotent;
 * `git fetch --quiet` if it exists, `git clone --bare` if not), the
 * lead worktree, and the per-project `.mcp.json` pointing at
 * `bin/zapbot-spawn-mcp.ts`.
 *
 * Called from the orchestrator entrypoint at boot for every project
 * declared in `~/.zapbot/projects.json` (sub-issue #9). Idempotent;
 * safe to re-run on SIGHUP.
 */
export function ensureProjectCheckout(
  projectSlug: ProjectSlug,
  cloneUrl: string,
  defaultBranch: string,
  deps: RunnerDeps,
): Effect.Effect<void, OrchestratorError, never> {
  void projectSlug;
  void cloneUrl;
  void defaultBranch;
  void deps;
  throw new Error("not implemented: ensureProjectCheckout");
}
