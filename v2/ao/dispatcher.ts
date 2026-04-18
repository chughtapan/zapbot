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
 * Invoke `ao spawn <issue>` with env `AO_CONFIG_PATH`, `AO_PROJECT_ID`,
 * `GH_TOKEN`. Returns the ao session name on success.
 *
 * No retry — v1's retry loop was coupled to DB rows; v2 callers that want
 * retry wrap this themselves.
 */
export async function dispatch(
  ctx: DispatchContext
): Promise<Result<AoSessionName, DispatchError>> {
  const spawnEnv: Record<string, string | undefined> = {
    ...process.env,
    AO_CONFIG_PATH: ctx.configPath,
    AO_PROJECT_ID: ctx.projectName as unknown as string,
    GH_TOKEN: ctx.installationToken as unknown as string,
  };

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
