import { describe, it, expect } from "vitest";
import { makeWorkflowId } from "../src/workflow-id.js";

describe("makeWorkflowId", () => {
  it("produces wf-{owner}-{repo}-{issue} for standard input", () => {
    expect(makeWorkflowId("owner/repo", 42)).toBe("wf-owner-repo-42");
  });

  it("handles repo name with no slash gracefully", () => {
    // replace("/", "-") on a string with no slash is a no-op
    expect(makeWorkflowId("repo", 42)).toBe("wf-repo-42");
  });

  it("handles issue number 0", () => {
    expect(makeWorkflowId("owner/repo", 0)).toBe("wf-owner-repo-0");
  });

  it("handles large issue numbers", () => {
    expect(makeWorkflowId("owner/repo", 999999)).toBe("wf-owner-repo-999999");
  });
});
