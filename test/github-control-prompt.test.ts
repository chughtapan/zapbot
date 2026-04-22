import { describe, expect, it } from "vitest";
import { buildEligibleMentionRequest } from "../src/github-control-request.ts";
import { toOrchestratorControlPrompt } from "../src/orchestrator/github-control-prompt.ts";
import {
  asCommentId,
  asDeliveryId,
  asIssueNumber,
  asProjectName,
  asRepoFullName,
} from "../src/types.ts";

describe("toOrchestratorControlPrompt", () => {
  it("renders the raw GitHub comment into a durable orchestrator prompt", () => {
    const request = buildEligibleMentionRequest({
      placement: {
        repo: asRepoFullName("acme/app"),
        projectName: asProjectName("app"),
        issue: asIssueNumber(42),
        issueThreadKind: "pull_request",
        issueTitle: "Ship raw GitHub message intake",
        issueUrl: "https://github.com/acme/app/issues/42",
        commentId: asCommentId(77),
        commentUrl: "https://github.com/acme/app/issues/42#issuecomment-77",
        deliveryId: asDeliveryId("delivery-1"),
      },
      rawCommentBody: "@zapbot please review the open work and decide the next step",
      triggeredBy: "carol",
    });
    expect(request._tag).toBe("Ok");
    if (request._tag !== "Ok") return;
    const result = toOrchestratorControlPrompt(request.value);
    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok") return;
    expect(result.value.title).toContain("acme/app#42");
    expect(result.value.body).toContain("issue_thread_kind: pull_request");
    expect(result.value.body).toContain("issue_title: Ship raw GitHub message intake");
    expect(result.value.body).toContain("github_comment_body:");
    expect(result.value.body).toContain("please review the open work");
    expect(result.value.body).toContain("bun run bin/ao-spawn-with-moltzap.ts");
  });
});
