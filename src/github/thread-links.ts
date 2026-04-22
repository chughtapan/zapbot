/**
 * github/thread-links — resolve a canonical issue-thread anchor into a
 * durable mirror target set.
 */

import { err, ok } from "../types.ts";
import type { GitHubStateService } from "../github-state.ts";
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
  state: Pick<GitHubStateService, "getIssue" | "getLinkedPullRequest">,
): Promise<Result<ThreadMirrorTargets, GithubStateError>> {
  const issue = await state.getIssue(anchor.repo, anchor.issue);
  if (issue._tag === "Err") return err(issue.error);

  const linkedPullRequest = await state.getLinkedPullRequest(anchor.repo, anchor.issue);
  if (linkedPullRequest._tag === "Err") return err(linkedPullRequest.error);

  return ok({
    repo: anchor.repo,
    issue: anchor.issue,
    linkedPullRequest: linkedPullRequest.value,
  });
}
