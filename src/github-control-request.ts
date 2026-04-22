import type {
  CommentId,
  DeliveryId,
  IssueNumber,
  ProjectName,
  RepoFullName,
  Result,
} from "./types.ts";

export type IssueThreadKind = "issue" | "pull_request";

export interface GitHubPlacementContext {
  readonly repo: RepoFullName;
  readonly projectName: ProjectName;
  readonly issue: IssueNumber;
  readonly issueThreadKind: IssueThreadKind;
  readonly issueTitle: string | null;
  readonly issueUrl: string | null;
  readonly commentId: CommentId;
  readonly commentUrl: string | null;
  readonly deliveryId: DeliveryId;
}

export interface EligibleMentionRequest {
  readonly _tag: "EligibleMentionRequest";
  readonly placement: GitHubPlacementContext;
  readonly rawCommentBody: string;
  readonly triggeredBy: string;
}

export type EligibleMentionRequestError =
  | { readonly _tag: "PlacementInvalid"; readonly reason: string }
  | { readonly _tag: "RawCommentBodyInvalid"; readonly reason: string }
  | { readonly _tag: "TriggeredByInvalid"; readonly reason: string };

export function buildEligibleMentionRequest(args: {
  readonly placement: GitHubPlacementContext;
  readonly rawCommentBody: string;
  readonly triggeredBy: string;
}): Result<EligibleMentionRequest, EligibleMentionRequestError> {
  throw new Error("not implemented");
}
