/**
 * github/thread-links — resolve a canonical issue-thread anchor into a
 * durable mirror target set.
 */

import { getIssue, getLinkedPullRequest } from "../github-state.ts";
import { err, ok } from "../types.ts";
import type { GithubStateError, IssueNumber, RepoFullName, Result } from "../types.ts";

export interface IssueThreadAnchor {
  readonly repo: RepoFullName;
  readonly issue: IssueNumber;
}

export interface ThreadMirrorTargets extends IssueThreadAnchor {
  readonly linkedPullRequest: IssueNumber | null;
}

export async function resolveThreadMirrorTargets(
  anchor: IssueThreadAnchor,
): Promise<Result<ThreadMirrorTargets, GithubStateError>> {
  const issue = await getIssue(anchor.repo, anchor.issue);
  if (issue._tag === "Err") return err(issue.error);

  const linkedPullRequest = await getLinkedPullRequest(anchor.repo, anchor.issue);
  if (linkedPullRequest._tag === "Err") return err(linkedPullRequest.error);

  return ok({
    repo: anchor.repo,
    issue: anchor.issue,
    linkedPullRequest: linkedPullRequest.value,
  });
}
