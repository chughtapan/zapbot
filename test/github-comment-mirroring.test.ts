import { describe, it, expect } from "vitest";
import { mirrorDurableStatusComment, type CommentMirrorSink } from "../src/github/comment-mirroring.ts";
import { asCommentId, asIssueNumber, asRepoFullName, err, ok } from "../src/types.ts";
import type { ThreadMirrorTargets } from "../src/github/thread-links.ts";

const repo = asRepoFullName("acme/app");
const issue = asIssueNumber(42);
const pr = asIssueNumber(77);

describe("mirrorDurableStatusComment", () => {
  it("posts to issue and linked PR when both succeed", async () => {
    const calls: Array<{ repo: string; issue: number; body: string }> = [];
    const sink: CommentMirrorSink = {
      postComment: async (repo, issue, body) => {
        calls.push({ repo: repo as unknown as string, issue: issue as unknown as number, body });
        return ok(asCommentId(calls.length));
      },
    };
    const targets: ThreadMirrorTargets = { repo, issue, linkedPullRequest: pr };
    const r = await mirrorDurableStatusComment(
      targets,
      { source: "bridge", body: "status update" },
      sink,
    );
    expect(r._tag).toBe("Ok");
    if (r._tag === "Ok") {
      expect(r.value.linkedPullRequestMirror._tag).toBe("Mirrored");
      if (r.value.linkedPullRequestMirror._tag === "Mirrored") {
        expect(r.value.linkedPullRequestMirror.linkedPullRequestCommentId as unknown as number).toBe(2);
      }
    }
    expect(calls).toEqual([
      { repo: "acme/app", issue: 42, body: "status update" },
      { repo: "acme/app", issue: 77, body: "status update" },
    ]);
  });

  it("records a partial failure when the linked PR post fails", async () => {
    const sink: CommentMirrorSink = {
      postComment: async (repo, issue, body) => {
        if ((issue as unknown as number) === 42) {
          return ok(asCommentId(1));
        }
        return err({ _tag: "GhCallFailed", label: "postComment", cause: "boom" });
      },
    };
    const r = await mirrorDurableStatusComment(
      { repo, issue, linkedPullRequest: pr },
      { source: "bridge", body: "status update" },
      sink,
    );
    expect(r._tag).toBe("Ok");
    if (r._tag === "Ok") {
      expect(r.value.linkedPullRequestMirror._tag).toBe("Failed");
    }
  });

  it("fails when the canonical issue post fails", async () => {
    const sink: CommentMirrorSink = {
      postComment: async () => err({ _tag: "GhCallFailed", label: "postComment", cause: "offline" }),
    };
    const r = await mirrorDurableStatusComment(
      { repo, issue, linkedPullRequest: null },
      { source: "bridge", body: "status update" },
      sink,
    );
    expect(r._tag).toBe("Err");
    if (r._tag === "Err") {
      expect(r.error._tag).toBe("IssueCommentPostFailed");
    }
  });
});
