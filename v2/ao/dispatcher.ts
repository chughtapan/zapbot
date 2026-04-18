/**
 * v2/ao/dispatcher — shell out to `ao spawn <issue>`.
 *
 * Principle 5: one responsibility — translate a dispatch intent into a
 * spawned `ao` process with the right env. No DB, no role-rules copy.
 */

import {
  asAoSessionName,
  err,
  ok,
} from "../types.ts";
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
  const env: Record<string, string> = {};
  for (const key of AO_ENV_ALLOWLIST) {
    const v = process.env[key];
    if (typeof v === "string") env[key] = v;
  }
  env.AO_CONFIG_PATH = ctx.configPath;
  env.AO_PROJECT_ID = ctx.projectName as unknown as string;
  env.GH_TOKEN = ctx.installationToken as unknown as string;
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
 * No retry — v1's retry loop was coupled to DB rows; v2 callers that want
 * retry wrap this themselves.
 */
export async function dispatch(
  ctx: DispatchContext
): Promise<Result<AoSessionName, DispatchError>> {
  const spawnEnv = buildSpawnEnv(ctx);

  try {
    const proc = Bun.spawn(["ao", "spawn", String(ctx.issue)], {
      env: spawnEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text().catch(() => "");
      return err({ _tag: "AoSpawnFailed", exitCode, stderr });
    }
    // Session name convention: `<projectName>-<issue>`. `ao` itself assigns it;
    // we reconstruct it here rather than parsing stdout for testability.
    return ok(asAoSessionName(`${ctx.projectName as unknown as string}-${ctx.issue}`));
  } catch (e) {
    return err({ _tag: "AoSpawnFailed", exitCode: -1, stderr: String(e) });
  }
}
