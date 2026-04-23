import { describe, it, expect } from "vitest";
import { resolveThreadMirrorTargets } from "../src/github/thread-links.ts";
import { ok } from "../src/types.ts";
import { asIssueNumber, asRepoFullName } from "../src/types.ts";

const repo = asRepoFullName("acme/app");
const issue = asIssueNumber(42);

describe("resolveThreadMirrorTargets", () => {
  it("returns the canonical issue and its linked pull request", async () => {
    const r = await resolveThreadMirrorTargets(
      { repo, issue },
      {
        getIssue: async () => ok({
          repo,
          number: issue,
          state: "open",
          labels: [],
          assignees: [],
          body: "issue body",
          author: "carol",
        }),
        getLinkedPullRequest: async () => ok(asIssueNumber(77)),
      },
    );

    expect(r._tag).toBe("Ok");
    if (r._tag === "Ok") {
      expect(r.value.repo).toBe(repo);
      expect(r.value.issue as unknown as number).toBe(42);
      expect(r.value.linkedPullRequest as unknown as number).toBe(77);
    }
  });
});
