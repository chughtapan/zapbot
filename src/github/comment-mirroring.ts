/**
 * github/comment-mirroring — fan out durable status comments to the canonical
 * issue thread and, when linked, the associated pull request thread.
 */

import { err, ok } from "../types.ts";
import type { CommentId, IssueNumber, RepoFullName, Result } from "../types.ts";
import type { ThreadMirrorTargets } from "./thread-links.ts";

export type DurableStatusCommentSource = "bridge" | "orchestrator";

export interface DurableStatusComment {
  readonly source: DurableStatusCommentSource;
  readonly body: string;
}

export interface CommentMirrorSink {
  readonly postComment: (
    repo: RepoFullName,
    issue: IssueNumber,
    body: string,
  ) => Promise<Result<CommentId, unknown>>;
}

export type LinkedPullRequestMirrorStatus =
  | { readonly _tag: "Mirrored"; readonly linkedPullRequestCommentId: CommentId }
  | { readonly _tag: "NotLinked" }
  | { readonly _tag: "Failed"; readonly cause: string };

export interface CommentMirrorReceipt {
  readonly issueCommentId: CommentId;
  readonly linkedPullRequestMirror: LinkedPullRequestMirrorStatus;
}

export type CommentMirrorError = {
  readonly _tag: "IssueCommentPostFailed";
  readonly cause: string;
};

export async function mirrorDurableStatusComment(
  targets: ThreadMirrorTargets,
  comment: DurableStatusComment,
  sink: CommentMirrorSink,
): Promise<Result<CommentMirrorReceipt, CommentMirrorError>> {
  const issueComment = await sink.postComment(targets.repo, targets.issue, comment.body);
  if (issueComment._tag === "Err") {
    return err({ _tag: "IssueCommentPostFailed", cause: stringifyError(issueComment.error) });
  }

  if (targets.linkedPullRequest === null) {
    return ok({
      issueCommentId: issueComment.value,
      linkedPullRequestMirror: { _tag: "NotLinked" },
    });
  }

  const linkedPullRequestComment = await sink.postComment(
    targets.repo,
    targets.linkedPullRequest,
    comment.body,
  );
  if (linkedPullRequestComment._tag === "Err") {
    return ok({
      issueCommentId: issueComment.value,
      linkedPullRequestMirror: {
        _tag: "Failed",
        cause: stringifyError(linkedPullRequestComment.error),
      },
    });
  }

  return ok({
    issueCommentId: issueComment.value,
    linkedPullRequestMirror: {
      _tag: "Mirrored",
      linkedPullRequestCommentId: linkedPullRequestComment.value,
    },
  });
}

function stringifyError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const maybeTag = (error as { _tag?: string })._tag;
    const maybeCause = (error as { cause?: unknown }).cause;
    if (typeof maybeTag === "string" && maybeCause !== undefined) {
      return `${maybeTag}: ${String(maybeCause)}`;
    }
    if (typeof maybeTag === "string") {
      return maybeTag;
    }
  }
  return String(error);
}
