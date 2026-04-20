import type { Result } from "../types.ts";
import type { CommentId, GhCallError, IssueNumber, RepoFullName } from "../types.ts";
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
  ) => Promise<Result<CommentId, GhCallError>>;
}

export interface CommentMirrorReceipt {
  readonly issueCommentId: CommentId;
  readonly linkedPullRequestCommentId: CommentId | null;
}

export type CommentMirrorError =
  | { readonly _tag: "IssueCommentPostFailed"; readonly cause: string }
  | { readonly _tag: "PullRequestCommentPostFailed"; readonly cause: string };

export function mirrorDurableStatusComment(
  targets: ThreadMirrorTargets,
  comment: DurableStatusComment,
  sink: CommentMirrorSink,
): Promise<Result<CommentMirrorReceipt, CommentMirrorError>> {
  throw new Error("not implemented");
}

