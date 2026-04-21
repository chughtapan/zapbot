import { describe, expect, it } from "vitest";
import { toOrchestratorControlPrompt } from "../src/orchestrator/control-event.ts";
import {
  asCommentId,
  asDeliveryId,
  asIssueNumber,
  asProjectName,
  asRepoFullName,
} from "../src/types.ts";

describe("toOrchestratorControlPrompt", () => {
  it("renders the raw GitHub comment into a durable orchestrator prompt", () => {
    const result = toOrchestratorControlPrompt({
      _tag: "GitHubControlEvent",
      repo: asRepoFullName("acme/app"),
      projectName: asProjectName("app"),
      issue: asIssueNumber(42),
      commentId: asCommentId(77),
      deliveryId: asDeliveryId("delivery-1"),
      commentBody: "@zapbot please review the open work and decide the next step",
      triggeredBy: "carol",
    });
    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok") return;
    expect(result.value.title).toContain("acme/app#42");
    expect(result.value.body).toContain("github_comment_body:");
    expect(result.value.body).toContain("please review the open work");
    expect(result.value.body).toContain("bun run bin/ao-spawn-with-moltzap.ts");
    expect(result.value.body).toContain("Do not fall back to plain `ao spawn`");
  });

  it("rejects blank GitHub comments", () => {
    const result = toOrchestratorControlPrompt({
      _tag: "GitHubControlEvent",
      repo: asRepoFullName("acme/app"),
      projectName: asProjectName("app"),
      issue: asIssueNumber(42),
      commentId: asCommentId(77),
      deliveryId: asDeliveryId("delivery-1"),
      commentBody: "   ",
      triggeredBy: "carol",
    });
    expect(result).toEqual({
      _tag: "Err",
      error: { _tag: "PromptShapeInvalid", reason: "commentBody must be a non-empty string" },
    });
  });
});
