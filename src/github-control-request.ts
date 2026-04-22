import type {
  CommentId,
  DeliveryId,
  IssueNumber,
  ProjectName,
  RepoFullName,
  Result,
} from "./types.ts";
import { err, ok } from "./types.ts";

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
  if (args.rawCommentBody.trim().length === 0) {
    return err({ _tag: "RawCommentBodyInvalid", reason: "rawCommentBody must be non-empty" });
  }
  if (args.triggeredBy.trim().length === 0) {
    return err({ _tag: "TriggeredByInvalid", reason: "triggeredBy must be non-empty" });
  }
  if ((args.placement.projectName as unknown as string).trim().length === 0) {
    return err({ _tag: "PlacementInvalid", reason: "projectName must be non-empty" });
  }
  if (
    args.placement.issueThreadKind !== "issue" &&
    args.placement.issueThreadKind !== "pull_request"
  ) {
    return err({ _tag: "PlacementInvalid", reason: "issueThreadKind must be issue or pull_request" });
  }
  if (
    args.placement.issueUrl !== null &&
    args.placement.issueUrl.trim().length === 0
  ) {
    return err({ _tag: "PlacementInvalid", reason: "issueUrl must be null or a non-empty string" });
  }
  if (
    args.placement.commentUrl !== null &&
    args.placement.commentUrl.trim().length === 0
  ) {
    return err({ _tag: "PlacementInvalid", reason: "commentUrl must be null or a non-empty string" });
  }
  return ok({
    _tag: "EligibleMentionRequest",
    placement: args.placement,
    rawCommentBody: args.rawCommentBody,
    triggeredBy: args.triggeredBy,
  });
}
