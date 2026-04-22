import { describe, expect, it } from "vitest";
import { buildEligibleMentionRequest } from "../src/github-control-request.ts";
import {
  asCommentId,
  asDeliveryId,
  asIssueNumber,
  asProjectName,
  asRepoFullName,
} from "../src/types.ts";

describe("buildEligibleMentionRequest", () => {
  it("builds a request with raw body and placement context", () => {
    const result = buildEligibleMentionRequest({
      placement: {
        repo: asRepoFullName("acme/app"),
        projectName: asProjectName("app"),
        issue: asIssueNumber(42),
        issueThreadKind: "pull_request",
        issueTitle: "Fix raw GitHub message intake",
        issueUrl: "https://github.com/acme/app/issues/42",
        commentId: asCommentId(77),
        commentUrl: "https://github.com/acme/app/issues/42#issuecomment-77",
        deliveryId: asDeliveryId("delivery-1"),
      },
      rawCommentBody: "@zapbot please investigate why this keeps failing",
      triggeredBy: "carol",
    });
    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok") return;
    expect(result.value.rawCommentBody).toContain("please investigate");
    expect(result.value.placement.issueThreadKind).toBe("pull_request");
  });

  it("rejects blank raw comment bodies", () => {
    const result = buildEligibleMentionRequest({
      placement: {
        repo: asRepoFullName("acme/app"),
        projectName: asProjectName("app"),
        issue: asIssueNumber(42),
        issueThreadKind: "issue",
        issueTitle: null,
        issueUrl: null,
        commentId: asCommentId(77),
        commentUrl: null,
        deliveryId: asDeliveryId("delivery-1"),
      },
      rawCommentBody: "   ",
      triggeredBy: "carol",
    });
    expect(result).toEqual({
      _tag: "Err",
      error: { _tag: "RawCommentBodyInvalid", reason: "rawCommentBody must be non-empty" },
    });
  });
});
