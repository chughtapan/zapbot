import type { Result } from "../types.ts";
import type { GithubStateError, IssueNumber, RepoFullName } from "../types.ts";

export interface ThreadMirrorTargets {
  readonly repo: RepoFullName;
  readonly issue: IssueNumber;
  readonly linkedPullRequest: IssueNumber | null;
}

export function resolveThreadMirrorTargets(
  repo: RepoFullName,
  issue: IssueNumber,
): Promise<Result<ThreadMirrorTargets, GithubStateError>> {
  throw new Error("not implemented");
}

