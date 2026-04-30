/**
 * orchestrator/runner — invoke the long-lived per-project Claude Code
 * session for one webhook turn (epic #369 D1, D3).
 *
 * Owns: per-project session-id persistence (`session.json`), the
 * advisory file lock that serializes concurrent webhooks for the same
 * project, the `claude -p --resume <id> "<message>"` subprocess
 * invocation, and stdout/stderr capture-to-disk
 * (`logs/turn-<deliveryId>.log`).
 *
 * Does not own: HTTP transport (server.ts), worker spawn (spawn-broker.ts),
 * webhook signature verification (bridge), GH_TOKEN minting (bridge), or
 * the project checkout layout (the runner expects `checkout/` to exist;
 * `ensureProjectCheckout` is its own export and is called from the boot
 * path before the first turn).
 */

import { Effect, Schema } from "effect";
import type { DeliveryId } from "../types.ts";
import { asDeliveryId } from "../types.ts";
import type { OrchestratorError } from "./errors.ts";
import type { GithubInstallationToken } from "./spawn-broker.ts";

// ── Branded identifiers ─────────────────────────────────────────────

export type ProjectSlug = string & { readonly __brand: "ProjectSlug" };
export type ClaudeSessionId = string & { readonly __brand: "ClaudeSessionId" };

export function asProjectSlug(s: string): ProjectSlug {
  return s as ProjectSlug;
}
export function asClaudeSessionId(s: string): ClaudeSessionId {
  return s as ClaudeSessionId;
}

// ── Public shapes ───────────────────────────────────────────────────

export interface TurnRequest {
  readonly projectSlug: ProjectSlug;
  readonly deliveryId: DeliveryId;
  readonly message: string;
  readonly githubToken: GithubInstallationToken;
}

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

export interface SessionState {
  readonly currentSessionId: ClaudeSessionId | null;
  readonly lastTurnAt: number;
  readonly lastDeliveryId: DeliveryId | null;
}

// ── DI seam ─────────────────────────────────────────────────────────

export interface RunnerDeps {
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
  /** Move a corrupt session.json aside; idempotent. */
  readonly stashCorruptSession: (
    path: string,
    nowMs: number,
  ) => Effect.Effect<void, OrchestratorError, never>;
  readonly acquireProjectLock: (
    lockPath: string,
    waitMs: number,
  ) => Effect.Effect<ProjectLock, OrchestratorError, never>;
  /**
   * Fetch the bare clone and fast-forward the lead worktree before
   * invoking claude. Implementation: `git fetch` against `cloneDir`
   * (the bare clone), then `git -C <worktreePath> pull --ff-only`. The
   * worktree must have a tracking branch (set up by `provisionCheckout`
   * via `git worktree add -b <branch> ...`).
   */
  readonly gitFetch: (
    projectSlug: ProjectSlug,
    cloneDir: string,
    worktreePath: string,
  ) => Effect.Effect<void, OrchestratorError, never>;
  /** Provision bare clone + worktree. Idempotent. */
  readonly provisionCheckout: (input: {
    readonly projectSlug: ProjectSlug;
    readonly cloneUrl: string;
    readonly defaultBranch: string;
    readonly bareClonePath: string;
    readonly worktreePath: string;
  }) => Effect.Effect<void, OrchestratorError, never>;
  /** Write `<projectsRoot>/<slug>/.mcp.json` for the lead session. */
  readonly writeMcpConfig: (
    path: string,
    body: string,
  ) => Effect.Effect<void, OrchestratorError, never>;
  readonly clock: () => number;
  readonly log: (
    level: "info" | "warn" | "error",
    msg: string,
    extra?: Record<string, unknown>,
  ) => void;
  readonly projectsRoot: string;
  readonly clonesRoot: string;
  readonly lockWaitMs: number;
  /**
   * The orchestrator HTTP URL that the lead session's MCP-tool process
   * should call. Used when writing `.mcp.json`.
   */
  readonly orchestratorUrl: string;
  /** Shared bearer secret written into `.mcp.json` env block. */
  readonly orchestratorSecret: string;
  /** Absolute path to `bin/zapbot-spawn-mcp.ts`. */
  readonly spawnMcpBinPath: string;
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

// ── Schemas (Principle 2: every disk read is schema-decoded) ────────

const SessionFileSchema = Schema.Struct({
  currentSessionId: Schema.Union(Schema.String, Schema.Null),
  lastTurnAt: Schema.Number,
  lastDeliveryId: Schema.Union(Schema.String, Schema.Null),
});

type SessionFile = Schema.Schema.Type<typeof SessionFileSchema>;

function decodeSessionFile(raw: string): SessionFile {
  const parsed: unknown = JSON.parse(raw);
  return Schema.decodeUnknownSync(SessionFileSchema)(parsed);
}

function projectDir(deps: RunnerDeps, slug: ProjectSlug): string {
  return `${deps.projectsRoot}/${slug}`;
}

function sessionPath(deps: RunnerDeps, slug: ProjectSlug): string {
  return `${projectDir(deps, slug)}/session.json`;
}

function lockPath(deps: RunnerDeps, slug: ProjectSlug): string {
  return `${projectDir(deps, slug)}/lock`;
}

function checkoutPath(deps: RunnerDeps, slug: ProjectSlug): string {
  return `${projectDir(deps, slug)}/checkout`;
}

function mcpConfigPath(deps: RunnerDeps, slug: ProjectSlug): string {
  return `${projectDir(deps, slug)}/.mcp.json`;
}

function clonePath(deps: RunnerDeps, slug: ProjectSlug): string {
  return `${deps.clonesRoot}/${slug}.git`;
}

function logFilePath(deps: RunnerDeps, slug: ProjectSlug, deliveryId: DeliveryId): string {
  return `${projectDir(deps, slug)}/logs/turn-${deliveryId}.log`;
}

// ── Public surface ──────────────────────────────────────────────────

/**
 * Run one webhook turn. Acquires the project lock, reads the current
 * session id, spawns claude with `--resume`, captures the new id,
 * persists it, and releases the lock. Idempotent over webhook
 * redelivery: if the incoming `deliveryId` matches the persisted
 * `lastDeliveryId`, returns `DuplicateDelivery` without re-invoking
 * claude.
 *
 * On `LeadSessionCorrupted`: the implementation moves the corrupt
 * `session.json` aside as `session.json.corrupt-<unix-ms>` and fails
 * the Effect; the next turn starts fresh (no `--resume`) and writes
 * a new session id.
 */
export function runTurn(
  request: TurnRequest,
  deps: RunnerDeps,
): Effect.Effect<TurnResponse, OrchestratorError, never> {
  return Effect.gen(function* () {
    const startedAt = deps.clock();

    const lock = yield* deps.acquireProjectLock(
      lockPath(deps, request.projectSlug),
      deps.lockWaitMs,
    );

    const releaseLock = lock.release();

    const finish = <A>(
      effect: Effect.Effect<A, OrchestratorError, never>,
    ): Effect.Effect<A, OrchestratorError, never> =>
      effect.pipe(Effect.tap(() => releaseLock), Effect.tapError(() => releaseLock));

    return yield* finish(
      Effect.gen(function* () {
        const state = yield* loadSessionState(request.projectSlug, deps);

        if (
          state.lastDeliveryId !== null &&
          state.lastDeliveryId === request.deliveryId &&
          state.currentSessionId !== null
        ) {
          deps.log("info", "runner: duplicate delivery", {
            projectSlug: request.projectSlug,
            deliveryId: request.deliveryId,
          });
          return {
            _tag: "DuplicateDelivery" as const,
            priorSessionId: state.currentSessionId,
          };
        }

        yield* deps.gitFetch(
          request.projectSlug,
          clonePath(deps, request.projectSlug),
          checkoutPath(deps, request.projectSlug),
        );

        const env: Record<string, string> = {
          GH_TOKEN: request.githubToken,
        };

        const spawnResult = yield* deps.spawnClaude({
          cwd: checkoutPath(deps, request.projectSlug),
          resumeSessionId: state.currentSessionId,
          message: request.message,
          mcpConfigPath: mcpConfigPath(deps, request.projectSlug),
          env,
          logFilePath: logFilePath(deps, request.projectSlug, request.deliveryId),
        });

        if (spawnResult.exitCode !== 0 || spawnResult.newSessionId === null) {
          return yield* Effect.fail<OrchestratorError>({
            _tag: "LeadProcessFailed",
            projectSlug: request.projectSlug,
            exitCode: spawnResult.exitCode,
            stderrTail: spawnResult.stderrTail,
          });
        }

        const nextState: SessionState = {
          currentSessionId: spawnResult.newSessionId,
          lastTurnAt: deps.clock(),
          lastDeliveryId: request.deliveryId,
        };

        yield* persistSessionState(request.projectSlug, nextState, deps);

        const durationMs = deps.clock() - startedAt;
        return {
          _tag: "Replied" as const,
          newSessionId: spawnResult.newSessionId,
          durationMs,
        };
      }),
    );
  });
}

/**
 * Read `<projectsRoot>/<slug>/session.json`. Returns the decoded
 * SessionState, or a synthetic `{ currentSessionId: null, lastTurnAt: 0,
 * lastDeliveryId: null }` if the file is absent. Fails with
 * `LeadSessionCorrupted` if the file exists but does not decode; before
 * failing, moves the corrupt file aside via `deps.stashCorruptSession`.
 */
export function loadSessionState(
  projectSlug: ProjectSlug,
  deps: RunnerDeps,
): Effect.Effect<SessionState, OrchestratorError, never> {
  const path = sessionPath(deps, projectSlug);
  return Effect.gen(function* () {
    const raw = yield* deps.readSessionFile(path);
    if (raw === null) {
      return {
        currentSessionId: null,
        lastTurnAt: 0,
        lastDeliveryId: null,
      };
    }
    let decoded: SessionFile;
    try {
      decoded = decodeSessionFile(raw);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      yield* deps.stashCorruptSession(path, deps.clock());
      return yield* Effect.fail<OrchestratorError>({
        _tag: "LeadSessionCorrupted",
        projectSlug,
        sessionPath: path,
        reason,
      });
    }
    return {
      currentSessionId:
        decoded.currentSessionId === null
          ? null
          : asClaudeSessionId(decoded.currentSessionId),
      lastTurnAt: decoded.lastTurnAt,
      lastDeliveryId:
        decoded.lastDeliveryId === null ? null : asDeliveryId(decoded.lastDeliveryId),
    };
  });
}

/**
 * Atomically replace `<projectsRoot>/<slug>/session.json` with the
 * given state. The deps' `writeSessionFile` is responsible for the
 * write-temp + rename atomicity.
 */
export function persistSessionState(
  projectSlug: ProjectSlug,
  state: SessionState,
  deps: RunnerDeps,
): Effect.Effect<void, OrchestratorError, never> {
  const body = JSON.stringify({
    currentSessionId: state.currentSessionId,
    lastTurnAt: state.lastTurnAt,
    lastDeliveryId: state.lastDeliveryId,
  });
  return deps.writeSessionFile(sessionPath(deps, projectSlug), body);
}

/**
 * Provision the per-project bare clone, lead-session worktree, and
 * `.mcp.json`. Idempotent; safe to re-run on SIGHUP.
 */
export function ensureProjectCheckout(
  projectSlug: ProjectSlug,
  cloneUrl: string,
  defaultBranch: string,
  deps: RunnerDeps,
): Effect.Effect<void, OrchestratorError, never> {
  return Effect.gen(function* () {
    yield* deps.provisionCheckout({
      projectSlug,
      cloneUrl,
      defaultBranch,
      bareClonePath: clonePath(deps, projectSlug),
      worktreePath: checkoutPath(deps, projectSlug),
    });

    // The lead session invokes `bun bin/zapbot-spawn-mcp.ts` rather
    // than `bin/zapbot-spawn-mcp.ts` directly. The shebang `#!/usr/bin/env
    // bun` would let `claude` exec the file as long as the executable
    // bit is set, but the bin file ships from a git checkout that does
    // not preserve mode 0755 across all extraction paths (PR diffs,
    // tarball reproductions, fresh worktrees). Going through `bun`
    // makes the exec mode-independent.
    const mcpBody = JSON.stringify(
      {
        mcpServers: {
          "zapbot-spawn": {
            command: "bun",
            args: [deps.spawnMcpBinPath],
            env: {
              ZAPBOT_ORCHESTRATOR_URL: deps.orchestratorUrl,
              ZAPBOT_SPAWN_SECRET: deps.orchestratorSecret,
            },
          },
        },
      },
      null,
      2,
    );

    yield* deps.writeMcpConfig(mcpConfigPath(deps, projectSlug), mcpBody);
  });
}
