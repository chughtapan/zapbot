/**
 * v2/ao/dispatcher — shell out to `ao spawn <issue>`.
 *
 * Principle 5: one responsibility — translate a dispatch intent into a
 * spawned `ao` process with the right env. No DB, no role-rules copy.
 */

import { spawn } from "node:child_process";
import {
  asAoSessionName,
  err,
  ok,
} from "../types.ts";
import { buildMoltzapSpawnEnv, type MoltzapRuntimeConfig } from "../moltzap/runtime.ts";
import type {
  AoSessionName,
  DispatchError,
  InstallationToken,
  IssueNumber,
  ProjectName,
  RepoFullName,
  Result,
} from "../types.ts";

export interface DispatchContext {
  readonly repo: RepoFullName;
  readonly issue: IssueNumber;
  readonly projectName: ProjectName;
  readonly configPath: string;
  readonly installationToken: InstallationToken;
  readonly moltzap: MoltzapRuntimeConfig;
}

/**
 * Parent-process env vars `ao` inherits. Intentionally narrow: the
 * bridge holds the broker key + installation PEM; the child only needs
 * the shell basics to run `gh`, `git`, and `ao` itself. Anything not
 * listed here is stripped before spawn.
 *
 * Adding to this list is a trust-boundary decision — justify in review.
 */
const AO_ENV_ALLOWLIST: ReadonlyArray<string> = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "TZ",
] as const;

function buildSpawnEnv(ctx: DispatchContext): Record<string, string> {
  return {
    ...buildBaseSpawnEnv(ctx),
    AO_CONFIG_PATH: ctx.configPath,
    AO_PROJECT_ID: ctx.projectName as unknown as string,
    GH_TOKEN: ctx.installationToken as unknown as string,
  };
}

function buildBaseSpawnEnv(ctx: DispatchContext): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of AO_ENV_ALLOWLIST) {
    const v = process.env[key];
    if (typeof v === "string") env[key] = v;
  }
  return env;
}

/**
 * Invoke `ao spawn <issue>` with env `AO_CONFIG_PATH`, `AO_PROJECT_ID`,
 * `GH_TOKEN` plus the `AO_ENV_ALLOWLIST`. Returns the ao session name on
 * success.
 *
 * Env posture: the spawned child does NOT inherit the bridge's full env.
 * Secrets the bridge holds (ZAPBOT_API_KEY, ZAPBOT_WEBHOOK_SECRET,
 * GITHUB_APP_PRIVATE_KEY, etc.) are never visible to `ao` or its
 * descendants — the installation token is the only credential passed.
 *
 * No retry — the legacy retry loop was coupled to DB rows; callers that want
 * retry wrap this themselves.
 */
export async function dispatch(
  ctx: DispatchContext
): Promise<Result<AoSessionName, DispatchError>> {
  const session = asAoSessionName(`${ctx.projectName as unknown as string}-${ctx.issue}`);
  const spawnEnv = buildSpawnEnv(ctx);
  const moltzapEnv = await buildMoltzapSpawnEnv(ctx.moltzap, {
    repo: ctx.repo,
    issue: ctx.issue,
    projectName: ctx.projectName,
    session,
  });
  if (moltzapEnv._tag === "Err") {
    return err({ _tag: "MoltzapProvisionFailed", cause: moltzapEnv.error.cause });
  }

  const spawnResult = await runAoSpawn(ctx.issue, { ...spawnEnv, ...moltzapEnv.value });
  if (spawnResult._tag === "Err") {
    return spawnResult;
  }

  // Session name convention: `<projectName>-<issue>`. `ao` itself assigns it;
  // we reconstruct it here rather than parsing stdout for testability.
  return ok(session);
}

function runAoSpawn(
  issue: IssueNumber,
  env: Record<string, string>,
): Promise<Result<void, DispatchError>> {
  return new Promise((resolve) => {
    let stderr = "";
    let settled = false;
    try {
      const proc = spawn("ao", ["spawn", String(issue)], {
        env,
        stdio: ["ignore", "ignore", "pipe"],
      });
      proc.stderr?.setEncoding("utf8");
      proc.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      proc.once("error", (cause) => {
        if (settled) return;
        settled = true;
        resolve(err({
          _tag: "AoSpawnFailed",
          exitCode: -1,
          stderr: cause instanceof Error ? cause.message : String(cause),
        }));
      });
      proc.once("close", (exitCode) => {
        if (settled) return;
        settled = true;
        if (exitCode === 0) {
          resolve(ok(undefined));
          return;
        }
        resolve(err({
          _tag: "AoSpawnFailed",
          exitCode: exitCode ?? -1,
          stderr,
        }));
      });
    } catch (cause) {
      resolve(err({
        _tag: "AoSpawnFailed",
        exitCode: -1,
        stderr: cause instanceof Error ? cause.message : String(cause),
      }));
    }
  });
}
