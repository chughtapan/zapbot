#!/usr/bin/env bun
/**
 * bin/zapbot-orchestrator — entrypoint for the long-lived orchestrator
 * process (epic #369 D2). Mirrors `bin/webhook-bridge.ts`'s shape:
 * env handoff, top-level fatal catch, all heavy lifting in
 * `src/orchestrator/*`.
 *
 * On first run, auto-creates `~/.zapbot/config.json` (mints
 * `orchestratorSecret` if missing) and treats `~/.zapbot/projects.json`
 * as empty if absent. Operators do not need to pre-stage these files;
 * `bin/zapbot-team-init` (sub-issue #9) will populate `projects.json`
 * with project entries.
 *
 * `~/.zapbot/projects.json` shape:
 *   {
 *     "<slug>": { "repo": "owner/name", "defaultBranch": "main" }
 *   }
 * Sub-issue #9 (zapbot-team-init) writes this; the orchestrator only
 * reads it.
 *
 * Boot sequence (implemented by `runOrchestratorProcess`):
 *   1. Decode `~/.zapbot/config.json` (webhookSecret, apiKey,
 *      orchestratorSecret).
 *   2. Mint orchestratorSecret if absent and persist it back.
 *   3. Construct LaunchDeps (spawn / fetch / clock / log / fs / randomHex).
 *   4. Resolve moltzap workspace paths from the vendored submodule.
 *   5. Construct stub RuntimeServerHandle (spawn-broker.ts).
 *   6. Construct SpawnBrokerHandle.
 *   7. For every project in `~/.zapbot/projects.json`, call
 *      ensureProjectCheckout to provision the bare clone + worktree
 *      + .mcp.json.
 *   8. Construct RunnerDeps.
 *   9. Construct ServerDeps and call startOrchestratorServer.
 *  10. Install SIGINT/SIGTERM handlers: server.close → broker.stopAll
 *      → process.exit(0). On SIGHUP: re-read projects.json and call
 *      ensureProjectCheckout for any new projects (no-op for known ones).
 */

import { Effect, Schema } from "effect";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import type { OrchestratorError } from "../src/orchestrator/errors.ts";
import {
  asProjectSlug,
  ensureProjectCheckout,
  type ClaudeSessionId,
  type ClaudeSpawnArgs,
  type ClaudeSpawnResult,
  type ProjectLock,
  type ProjectSlug,
  type RunnerDeps,
} from "../src/orchestrator/runner.ts";
import {
  asHttpPort,
  asSharedSecret,
  startOrchestratorServer,
  type ServerDeps,
} from "../src/orchestrator/server.ts";
import {
  createSpawnBroker,
  createStubRuntimeServerHandle,
  type SpawnBrokerDeps,
  type SpawnBrokerHandle,
} from "../src/orchestrator/spawn-broker.ts";

const execFileAsync = promisify(execFile);

// ── Config schemas ─────────────────────────────────────────────────

const OrchestratorConfigSchema = Schema.Struct({
  webhookSecret: Schema.NonEmptyString,
  apiKey: Schema.NonEmptyString,
  orchestratorSecret: Schema.optional(Schema.NonEmptyString),
});

const ProjectsFileSchema = Schema.Record({
  key: Schema.NonEmptyString,
  value: Schema.Struct({
    repo: Schema.NonEmptyString,
    defaultBranch: Schema.NonEmptyString,
  }),
});

type ProjectsFile = Schema.Schema.Type<typeof ProjectsFileSchema>;

// ── Public surface ──────────────────────────────────────────────────

/**
 * Boot the orchestrator. Resolves never on the happy path; fails with
 * `OrchestratorError` if config / checkout provisioning / port-bind
 * fails before the server is up.
 */
export function runOrchestratorProcess(
  env: NodeJS.ProcessEnv,
): Effect.Effect<never, OrchestratorError, never> {
  return Effect.gen(function* () {
    const home = env.HOME ?? os.homedir();
    const configPath = env.ZAPBOT_CONFIG_PATH ?? path.join(home, ".zapbot", "config.json");
    const projectsPath =
      env.ZAPBOT_PROJECTS_PATH ?? path.join(home, ".zapbot", "projects.json");
    const projectsRoot = env.ZAPBOT_PROJECTS_ROOT ?? path.join(home, ".zapbot", "projects");
    const clonesRoot = env.ZAPBOT_CLONES_ROOT ?? path.join(home, ".zapbot", "clones");
    const httpPort = asHttpPort(parseInt(env.ZAPBOT_ORCHESTRATOR_PORT ?? "3002", 10));
    const orchestratorUrl =
      env.ZAPBOT_ORCHESTRATOR_URL ?? `http://127.0.0.1:${httpPort}`;
    const moltzapServerUrl = env.MOLTZAP_SERVER_URL ?? "http://127.0.0.1:3100";
    const moltzapApiKey = env.MOLTZAP_AGENT_KEY ?? "";

    fs.mkdirSync(projectsRoot, { recursive: true });
    fs.mkdirSync(clonesRoot, { recursive: true });

    const secret = yield* loadOrMintSecret(configPath);

    const moltzapPaths = yield* resolveMoltzapPaths();

    const stubHandle = createStubRuntimeServerHandle({
      clock: () => Date.now(),
      fakeReadyDelayMs: parseInt(env.ZAPBOT_STUB_READY_DELAY_MS ?? "1500", 10),
    });

    const spawnMcpBinPath =
      env.ZAPBOT_SPAWN_MCP_BIN ??
      path.resolve(path.dirname(new URL(import.meta.url).pathname), "zapbot-spawn-mcp.ts");

    const brokerDeps: SpawnBrokerDeps = {
      server: stubHandle,
      clock: () => Date.now(),
      randomHex: (bytes) => crypto.randomBytes(bytes).toString("hex"),
      log: (level, msg, extra) =>
        process.stderr.write(
          `[orchestrator] ${level} ${msg}${extra ? ` ${JSON.stringify(extra)}` : ""}\n`,
        ),
      claudeBin: moltzapPaths.claudeBin,
      channelDistDir: moltzapPaths.channelDistDir,
      moltzapRepoRoot: moltzapPaths.repoRoot,
      moltzapServerUrl,
      moltzapApiKey,
      readyTimeoutMs: parseInt(env.ZAPBOT_READY_TIMEOUT_MS ?? "60000", 10),
    };

    const broker: SpawnBrokerHandle = createSpawnBroker(brokerDeps);

    const runnerDeps = makeProductionRunnerDeps({
      projectsRoot,
      clonesRoot,
      orchestratorUrl,
      orchestratorSecret: secret,
      spawnMcpBinPath,
      lockWaitMs: parseInt(env.ZAPBOT_LOCK_WAIT_MS ?? "30000", 10),
    });

    let projects: ProjectsFile = yield* loadProjects(projectsPath);
    yield* provisionAll(projects, runnerDeps);

    const serverDeps: ServerDeps = {
      secret: asSharedSecret(secret),
      port: httpPort,
      runnerDeps,
      broker,
      projectsCount: () => Object.keys(projects).length,
      log: (level, msg, extra) =>
        process.stderr.write(
          `[orchestrator] ${level} ${msg}${extra ? ` ${JSON.stringify(extra)}` : ""}\n`,
        ),
    };

    const handle = yield* startOrchestratorServer(serverDeps);

    const shutdown = Effect.gen(function* () {
      yield* handle.close();
      yield* broker.stopAll();
    });

    const onTerminationSignal = (signal: string): void => {
      Effect.runFork(
        shutdown.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              process.stderr.write(`[orchestrator] shut down on ${signal}\n`);
              process.exit(0);
            }),
          ),
        ),
      );
    };

    process.on("SIGINT", () => onTerminationSignal("SIGINT"));
    process.on("SIGTERM", () => onTerminationSignal("SIGTERM"));
    process.on("SIGHUP", () => {
      Effect.runFork(
        Effect.gen(function* () {
          const next = yield* loadProjects(projectsPath);
          yield* provisionAll(next, runnerDeps);
          projects = next;
        }).pipe(
          Effect.catchAll((cause) =>
            Effect.sync(() =>
              process.stderr.write(
                `[orchestrator] SIGHUP reload failed: ${JSON.stringify(cause)}\n`,
              ),
            ),
          ),
        ),
      );
    });

    return yield* Effect.never;
  });
}

// ── Helpers ─────────────────────────────────────────────────────────

interface MoltzapPaths {
  readonly repoRoot: string;
  readonly claudeBin: string;
  readonly channelDistDir: string;
}

function resolveMoltzapPaths(): Effect.Effect<MoltzapPaths, OrchestratorError, never> {
  return Effect.try({
    try: (): MoltzapPaths => {
      const here = path.dirname(new URL(import.meta.url).pathname);
      const repoRoot = path.resolve(here, "..", "vendor", "moltzap");
      const channelDistDir = path.join(
        repoRoot,
        "packages",
        "claude-code-channel",
        "dist",
      );
      const claudeBin = path.join(repoRoot, "node_modules", ".bin", "claude");
      return { repoRoot, claudeBin, channelDistDir };
    },
    catch: (cause): OrchestratorError => ({
      _tag: "BootConfigInvalid",
      source: "moltzap-paths",
      path: "vendor/moltzap",
      reason: cause instanceof Error ? cause.message : String(cause),
    }),
  });
}

function loadOrMintSecret(
  configPath: string,
): Effect.Effect<string, OrchestratorError, never> {
  return Effect.try({
    try: (): string => {
      let raw: string;
      try {
        raw = fs.readFileSync(configPath, "utf8");
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
          // No config file — mint a fresh secret and write a minimal file.
          const minted = crypto.randomBytes(32).toString("hex");
          fs.mkdirSync(path.dirname(configPath), { recursive: true });
          fs.writeFileSync(
            configPath,
            JSON.stringify(
              {
                webhookSecret: crypto.randomBytes(32).toString("hex"),
                apiKey: crypto.randomBytes(32).toString("hex"),
                orchestratorSecret: minted,
              },
              null,
              2,
            ),
          );
          return minted;
        }
        throw cause;
      }
      const parsed: unknown = JSON.parse(raw);
      const decoded = Schema.decodeUnknownSync(OrchestratorConfigSchema)(parsed);
      if (decoded.orchestratorSecret !== undefined) return decoded.orchestratorSecret;
      const minted = crypto.randomBytes(32).toString("hex");
      const merged = { ...(parsed as object), orchestratorSecret: minted };
      fs.writeFileSync(configPath, JSON.stringify(merged, null, 2));
      return minted;
    },
    catch: (cause): OrchestratorError => ({
      _tag: "BootConfigInvalid",
      source: "config.json",
      path: configPath,
      reason: cause instanceof Error ? cause.message : String(cause),
    }),
  });
}

function loadProjects(
  projectsPath: string,
): Effect.Effect<ProjectsFile, OrchestratorError, never> {
  return Effect.try({
    try: (): ProjectsFile => {
      let raw: string;
      try {
        raw = fs.readFileSync(projectsPath, "utf8");
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
          return {} as ProjectsFile;
        }
        throw cause;
      }
      const parsed: unknown = JSON.parse(raw);
      return Schema.decodeUnknownSync(ProjectsFileSchema)(parsed);
    },
    catch: (cause): OrchestratorError => ({
      _tag: "BootConfigInvalid",
      source: "projects.json",
      path: projectsPath,
      reason: cause instanceof Error ? cause.message : String(cause),
    }),
  });
}

function provisionAll(
  projects: ProjectsFile,
  runnerDeps: RunnerDeps,
): Effect.Effect<void, OrchestratorError, never> {
  return Effect.forEach(
    Object.entries(projects),
    ([slug, descriptor]) =>
      ensureProjectCheckout(
        asProjectSlug(slug),
        cloneUrlFromRepo(descriptor.repo),
        descriptor.defaultBranch,
        runnerDeps,
      ),
    { discard: true },
  );
}

function cloneUrlFromRepo(repo: string): string {
  // GitHub-only for now; matches the bridge's auth-app token scope.
  return `https://github.com/${repo}.git`;
}

interface ProductionRunnerDepsInput {
  readonly projectsRoot: string;
  readonly clonesRoot: string;
  readonly orchestratorUrl: string;
  readonly orchestratorSecret: string;
  readonly spawnMcpBinPath: string;
  readonly lockWaitMs: number;
}

function makeProductionRunnerDeps(input: ProductionRunnerDepsInput): RunnerDeps {
  return {
    spawnClaude: (args: ClaudeSpawnArgs) => productionSpawnClaude(args),
    readSessionFile: (filePath: string) =>
      Effect.try({
        try: (): string | null => {
          try {
            return fs.readFileSync(filePath, "utf8");
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw cause;
          }
        },
        catch: (cause): OrchestratorError => ({
          _tag: "LeadSessionCorrupted",
          projectSlug: extractSlugFromPath(filePath),
          sessionPath: filePath,
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
      }),
    writeSessionFile: (filePath: string, body: string) =>
      Effect.try({
        try: (): void => {
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          const tmp = `${filePath}.tmp`;
          fs.writeFileSync(tmp, body);
          fs.renameSync(tmp, filePath);
        },
        catch: (cause): OrchestratorError => ({
          _tag: "LeadSessionCorrupted",
          projectSlug: extractSlugFromPath(filePath),
          sessionPath: filePath,
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
      }),
    stashCorruptSession: (filePath: string, nowMs: number) =>
      Effect.try({
        try: (): void => {
          try {
            fs.renameSync(filePath, `${filePath}.corrupt-${nowMs}`);
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
            throw cause;
          }
        },
        catch: (cause): OrchestratorError => ({
          _tag: "LeadSessionCorrupted",
          projectSlug: extractSlugFromPath(filePath),
          sessionPath: filePath,
          reason: `stash failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
      }),
    acquireProjectLock: productionAcquireLock,
    gitFetch: (projectSlug: ProjectSlug, cloneDir: string, worktreePath: string) =>
      Effect.gen(function* () {
        const wrap = (cause: unknown): OrchestratorError => ({
          _tag: "GitFetchFailed",
          projectSlug,
          stderrTail: cause instanceof Error ? cause.message : String(cause),
        });
        // Refresh the bare clone first; the lead worktree shares its
        // object DB so the subsequent fast-forward sees the new commits.
        yield* Effect.tryPromise({
          try: () => execFileAsync("git", ["--git-dir", cloneDir, "fetch", "--quiet"]),
          catch: wrap,
        });
        // Fast-forward the lead worktree to the latest origin/<branch>.
        // `--ff-only` fails closed on diverged history; the orchestrator
        // surfaces that as `GitFetchFailed` and the bridge retries on the
        // next webhook.
        yield* Effect.tryPromise({
          try: () =>
            execFileAsync("git", ["-C", worktreePath, "pull", "--ff-only", "--quiet"]),
          catch: wrap,
        });
      }),
    provisionCheckout: ({
      projectSlug,
      cloneUrl,
      defaultBranch,
      bareClonePath,
      worktreePath,
    }) =>
      Effect.gen(function* () {
        const checkoutFailure = (
          cause: unknown,
          stage: "clone" | "worktree-add" | "fetch",
        ): OrchestratorError => ({
          _tag: "ProjectCheckoutFailed",
          projectSlug,
          stage,
          stderrTail: cause instanceof Error ? cause.message : String(cause),
        });

        if (fs.existsSync(bareClonePath)) {
          // Fetch failure on an existing clone is non-fatal — log and
          // continue; GitFetchFailed surfaces on the next turn.
          yield* Effect.tryPromise({
            try: () =>
              execFileAsync("git", ["--git-dir", bareClonePath, "fetch", "--quiet"]),
            catch: (cause): OrchestratorError => checkoutFailure(cause, "fetch"),
          }).pipe(
            Effect.catchAll((error) =>
              Effect.sync(() => {
                const tail =
                  error._tag === "ProjectCheckoutFailed" ? error.stderrTail : "";
                process.stderr.write(
                  `[orchestrator] git fetch on existing clone failed: ${tail}\n`,
                );
              }),
            ),
          );
        } else {
          // `git init --bare` + `remote add origin` + fetch. We can't use
          // `git clone --bare` directly: it copies `refs/heads/*` from the
          // remote into the bare clone, which then conflicts with
          // `git worktree add --track -b <branch>` ("a branch named '<branch>'
          // already exists"). `--mirror` has the same problem because its
          // `+refs/*:refs/*` refspec also lands branches in `refs/heads/`.
          // Init-bare starts the refs empty; the standard fetch refspec
          // populates ONLY `refs/remotes/origin/*`, leaving `refs/heads/`
          // free for worktree-add to write to.
          yield* Effect.try({
            try: (): void => {
              fs.mkdirSync(bareClonePath, { recursive: true });
            },
            catch: (cause): OrchestratorError => checkoutFailure(cause, "clone"),
          });
          yield* Effect.tryPromise({
            try: () =>
              execFileAsync("git", [
                "--git-dir",
                bareClonePath,
                "init",
                "--bare",
                "--quiet",
              ]),
            catch: (cause): OrchestratorError => checkoutFailure(cause, "clone"),
          });
          yield* Effect.tryPromise({
            try: () =>
              execFileAsync("git", [
                "--git-dir",
                bareClonePath,
                "remote",
                "add",
                "origin",
                cloneUrl,
              ]),
            catch: (cause): OrchestratorError => checkoutFailure(cause, "clone"),
          });
          yield* Effect.tryPromise({
            try: () =>
              execFileAsync("git", [
                "--git-dir",
                bareClonePath,
                "fetch",
                "--quiet",
                "origin",
              ]),
            catch: (cause): OrchestratorError => checkoutFailure(cause, "clone"),
          });
        }

        if (!fs.existsSync(worktreePath)) {
          yield* Effect.try({
            try: (): void => {
              fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
            },
            catch: (cause): OrchestratorError => checkoutFailure(cause, "worktree-add"),
          });
          // Create the worktree on a tracking branch so subsequent
          // `git pull --ff-only` against the worktree picks up new
          // commits without needing the branch name explicitly.
          yield* Effect.tryPromise({
            try: () =>
              execFileAsync("git", [
                "--git-dir",
                bareClonePath,
                "worktree",
                "add",
                "--quiet",
                "--track",
                "-b",
                defaultBranch,
                worktreePath,
                `origin/${defaultBranch}`,
              ]),
            catch: (cause): OrchestratorError => checkoutFailure(cause, "worktree-add"),
          });
        }
      }),
    writeMcpConfig: (filePath: string, body: string) =>
      Effect.try({
        try: (): void => {
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, body);
        },
        catch: (cause): OrchestratorError => ({
          _tag: "McpConfigWriteFailed",
          projectSlug: extractSlugFromPath(filePath),
          path: filePath,
          cause: cause instanceof Error ? cause.message : String(cause),
        }),
      }),
    clock: () => Date.now(),
    log: (level, msg, extra) =>
      process.stderr.write(
        `[orchestrator/runner] ${level} ${msg}${extra ? ` ${JSON.stringify(extra)}` : ""}\n`,
      ),
    projectsRoot: input.projectsRoot,
    clonesRoot: input.clonesRoot,
    lockWaitMs: input.lockWaitMs,
    orchestratorUrl: input.orchestratorUrl,
    orchestratorSecret: input.orchestratorSecret,
    spawnMcpBinPath: input.spawnMcpBinPath,
  };
}

function extractSlugFromPath(filePath: string): string {
  const parts = filePath.split(path.sep);
  const idx = parts.lastIndexOf("projects");
  return idx >= 0 && idx + 1 < parts.length ? parts[idx + 1] : "(unknown)";
}

const LOCK_POLL_MS = 100;

/**
 * Acquire an advisory project lock via the O_CREAT|O_EXCL pattern. Bun
 * does not expose flock(2); the open-with-EXCL pattern is portable
 * across Bun/Node and serializes contenders correctly. Stale-lock
 * recovery: when EEXIST is hit, read the PID stamped in the lockfile;
 * if the recorded PID is not alive (via `kill -0`), assume the prior
 * owner crashed and steal the lock.
 */
function productionAcquireLock(
  lockPath: string,
  waitMs: number,
): Effect.Effect<ProjectLock, OrchestratorError, never> {
  return Effect.gen(function* () {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const deadline = Date.now() + waitMs;
    let fd: number | null = null;
    while (fd === null) {
      // Local copy of the fd so a write failure after a successful
      // open does not leak the descriptor — `fs.closeSync` runs in
      // the catch's `finally` regardless of the write outcome.
      let opened: number | null = null;
      try {
        opened = fs.openSync(
          lockPath,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR,
          0o644,
        );
        fs.writeSync(opened, `${process.pid}\n`);
        fd = opened;
        opened = null;
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code;
        if (opened !== null) {
          // openSync succeeded but writeSync threw — close the fd
          // before classifying the error so we don't leak.
          try {
            fs.closeSync(opened);
          } catch (closeCause) {
            void closeCause;
          }
          return yield* Effect.fail<OrchestratorError>({
            _tag: "BootConfigInvalid",
            source: "config.json",
            path: lockPath,
            reason: `lockfile write failed after open: ${cause instanceof Error ? cause.message : String(cause)}`,
          });
        }
        if (code !== "EEXIST") {
          return yield* Effect.fail<OrchestratorError>({
            _tag: "LockTimeout",
            projectSlug: extractSlugFromPath(lockPath),
            waitedMs: waitMs,
          });
        }
        // Stale-lock recovery: if the PID stamped in the lockfile is
        // not alive, steal the lock by unlinking and retrying.
        try {
          const stamped = fs.readFileSync(lockPath, "utf8").trim();
          const pid = parseInt(stamped, 10);
          if (Number.isFinite(pid) && pid > 0) {
            try {
              process.kill(pid, 0);
              // Owner alive; fall through to wait
            } catch (killCause) {
              if ((killCause as NodeJS.ErrnoException).code === "ESRCH") {
                fs.unlinkSync(lockPath);
                continue;
              }
            }
          }
        } catch (readCause) {
          // Lock file vanished between EEXIST and read; retry.
          if ((readCause as NodeJS.ErrnoException).code === "ENOENT") {
            continue;
          }
        }
      }
      if (fd === null) {
        if (Date.now() >= deadline) {
          return yield* Effect.fail<OrchestratorError>({
            _tag: "LockTimeout",
            projectSlug: extractSlugFromPath(lockPath),
            waitedMs: waitMs,
          });
        }
        yield* Effect.sleep(`${LOCK_POLL_MS} millis`);
      }
    }
    const owned = fd;
    return {
      release: () =>
        Effect.sync(() => {
          try {
            fs.closeSync(owned);
          } catch (cause) {
            // Lock fd already released; lifecycle-only signal.
            void cause;
          }
          try {
            fs.unlinkSync(lockPath);
          } catch (cause) {
            // Lock file already removed; lifecycle-only signal.
            void cause;
          }
        }),
    };
  });
}

function productionSpawnClaude(
  args: ClaudeSpawnArgs,
): Effect.Effect<ClaudeSpawnResult, OrchestratorError, never> {
  return Effect.async<ClaudeSpawnResult, OrchestratorError, never>((resume) => {
    fs.mkdirSync(path.dirname(args.logFilePath), { recursive: true });
    // --output-format json so the runner can extract session_id (the
    // default text mode prints only the response text, no session id —
    // every fresh turn would then look like a session-corruption case
    // and dispatch fails 503 even on a clean lead-session exit).
    const claudeArgs: string[] = ["-p", "--output-format", "json"];
    if (args.resumeSessionId !== null) {
      claudeArgs.push("--resume", args.resumeSessionId);
    }
    claudeArgs.push("--mcp-config", args.mcpConfigPath);
    // `--` ends `--mcp-config`'s variadic <configs...> consumption, so
    // claude treats the message as the prompt positional and not as
    // another MCP config path. Without `--`, claude swallows the message
    // into --mcp-config and exits with "MCP config file not found".
    claudeArgs.push("--", args.message);

    const child = spawn("claude", claudeArgs, {
      cwd: args.cwd,
      env: { ...process.env, ...args.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const stream = fs.createWriteStream(args.logFilePath, { flags: "a" });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      stream.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      stream.write(chunk);
    });

    child.on("close", (exitCode: number | null) => {
      stream.end();
      resume(
        Effect.succeed<ClaudeSpawnResult>({
          exitCode: exitCode ?? -1,
          newSessionId: extractSessionId(stdout),
          stderrTail: stderr.slice(-4096),
        }),
      );
    });
    child.on("error", (cause: Error) => {
      stream.end();
      resume(
        Effect.fail<OrchestratorError>({
          _tag: "LeadProcessFailed",
          projectSlug: extractSlugFromPath(args.cwd),
          exitCode: null,
          stderrTail: cause.message,
        }),
      );
    });
  });
}

function extractSessionId(stdout: string): ClaudeSessionId | null {
  // claude -p --output-format text prints `session-id: <uuid>` on the
  // last line in resume mode; --output-format json prints a structured
  // payload. Match the textual line because zapbot does not pin format.
  const match = stdout.match(/session[_-]id["':\s]+([a-fA-F0-9-]{8,})/);
  return match ? (match[1] as ClaudeSessionId) : null;
}

// ── Top-level shim ──────────────────────────────────────────────────

if (import.meta.main) {
  process.on("unhandledRejection", (cause) => {
    console.error(
      "[orchestrator] Unhandled rejection (non-fatal):",
      cause instanceof Error ? cause.message : cause,
    );
  });
  Effect.runPromise(runOrchestratorProcess(process.env)).catch((cause: unknown) => {
    console.error(
      `[orchestrator] Fatal: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    process.exit(1);
  });
}
