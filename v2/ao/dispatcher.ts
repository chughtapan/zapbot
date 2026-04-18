/**
 * v2/ao/dispatcher — shell out to `ao spawn <issue>` with the bot's
 * installation token and the per-repo project id.
 *
 * Principle 5 (Junior Dev Rule): this module owns exactly one responsibility:
 * translate a "dispatch this issue" intent into a spawned `ao` process with
 * the right env. No DB writes, no role-rules file copy, no session lookup,
 * no heartbeat/cleanup. Those were v1 bookkeeping against the SQLite store.
 *
 * Invariant 3 from the spec: nested spawn is first-class. Agents call this
 * module's CLI equivalent (`ao spawn`) directly from their own VM; the
 * bridge is NOT a spawn-routing bottleneck. This module exists for the
 * bridge's own webhook-triggered spawns; nested spawns bypass it entirely.
 */

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
 * `GH_TOKEN`. Returns the ao session name on success. Does NOT wait for
 * the spawned agent to finish; returns as soon as `ao spawn` exits cleanly.
 *
 * Failure modes are enumerated in `DispatchError`. The caller decides
 * whether to retry (there is no built-in retry here — v1's retry loop was
 * coupled to DB rows; v2 callers that want retry build it from this).
 */
export function dispatch(
  _ctx: DispatchContext
): Promise<Result<AoSessionName, DispatchError>> {
  throw new Error("not implemented");
}
