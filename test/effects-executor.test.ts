import { describe, it, expect } from "vitest";
import { executeWithRetry, buildReconciliationComment, type EffectResult } from "../src/effects/executor.js";
import type { SideEffect } from "../src/state-machine/effects.js";

// ── executeWithRetry ──────────────────────────────────────────────

describe("executeWithRetry", () => {
  it("succeeds on first attempt for retryable effect", async () => {
    const effect: SideEffect = { type: "add_label", issueNumber: 1, label: "implementing" };
    const result = await executeWithRetry(effect, async () => {});
    expect(result.success).toBe(true);
    expect(result.retried).toBe(false);
  });

  it("succeeds on first attempt for non-retryable effect", async () => {
    const effect: SideEffect = { type: "spawn_agent", issueNumber: 1, role: "implementer" } as any;
    const result = await executeWithRetry(effect, async () => {});
    expect(result.success).toBe(true);
    expect(result.retried).toBe(false);
  });

  it("retries retryable effect and succeeds on second attempt", async () => {
    const effect: SideEffect = { type: "add_label", issueNumber: 1, label: "implementing" };
    let calls = 0;
    const result = await executeWithRetry(effect, async () => {
      calls++;
      if (calls === 1) throw new Error("GitHub API 500");
    });
    expect(result.success).toBe(true);
    expect(result.retried).toBe(true);
    expect(calls).toBe(2);
  });

  it("fails after retry for retryable effect", async () => {
    const effect: SideEffect = { type: "remove_label", issueNumber: 1, label: "planning" };
    const result = await executeWithRetry(effect, async () => {
      throw new Error("GitHub API down");
    });
    expect(result.success).toBe(false);
    expect(result.retried).toBe(true);
    expect(result.error).toContain("GitHub API down");
  });

  it("does NOT retry non-retryable effects", async () => {
    const effect: SideEffect = { type: "check_parent_completion", issueNumber: 1 } as any;
    let calls = 0;
    const result = await executeWithRetry(effect, async () => {
      calls++;
      throw new Error("internal error");
    });
    expect(result.success).toBe(false);
    expect(result.retried).toBe(false);
    expect(calls).toBe(1);
  });

  it("retries post_comment effect", async () => {
    const effect: SideEffect = { type: "post_comment", issueNumber: 5, body: "test" };
    let calls = 0;
    const result = await executeWithRetry(effect, async () => {
      calls++;
      if (calls === 1) throw new Error("rate limited");
    });
    expect(result.success).toBe(true);
    expect(result.retried).toBe(true);
  });

  it("retries close_issue effect", async () => {
    const effect: SideEffect = { type: "close_issue", issueNumber: 10 };
    let calls = 0;
    const result = await executeWithRetry(effect, async () => {
      calls++;
      if (calls === 1) throw new Error("timeout");
    });
    expect(result.success).toBe(true);
    expect(calls).toBe(2);
  });

  it("retries convert_pr_to_draft effect", async () => {
    const effect: SideEffect = { type: "convert_pr_to_draft", prNumber: 99 } as any;
    let calls = 0;
    await executeWithRetry(effect, async () => {
      calls++;
      if (calls === 1) throw new Error("graphql error");
    });
    expect(calls).toBe(2);
  });

  it("retries create_sub_issue effect", async () => {
    const effect: SideEffect = { type: "create_sub_issue", issueNumber: 1, title: "sub", body: "test" } as any;
    let calls = 0;
    await executeWithRetry(effect, async () => {
      calls++;
      if (calls === 1) throw new Error("api error");
    });
    expect(calls).toBe(2);
  });
});

// ── buildReconciliationComment ────────────────────────────────────

describe("buildReconciliationComment", () => {
  it("returns null for empty failures array", () => {
    expect(buildReconciliationComment([])).toBeNull();
  });

  it("builds comment for single failure", () => {
    const failures: EffectResult[] = [
      { effect: { type: "add_label", issueNumber: 1, label: "foo" }, success: false, retried: true, error: "API 500" },
    ];
    const comment = buildReconciliationComment(failures)!;
    expect(comment).toContain("add_label");
    expect(comment).toContain("API 500");
    expect(comment).toContain("Zapbot:");
    expect(comment).toContain("Failed effects:");
  });

  it("builds comment for multiple failures", () => {
    const failures: EffectResult[] = [
      { effect: { type: "add_label", issueNumber: 1, label: "x" }, success: false, retried: true, error: "err1" },
      { effect: { type: "remove_label", issueNumber: 1, label: "y" }, success: false, retried: true, error: "err2" },
      { effect: { type: "post_comment", issueNumber: 1, body: "z" }, success: false, retried: true, error: "err3" },
    ];
    const comment = buildReconciliationComment(failures)!;
    expect(comment).toContain("add_label");
    expect(comment).toContain("remove_label");
    expect(comment).toContain("post_comment");
    expect(comment.split("- `").length - 1).toBe(3); // 3 bullet points
  });

  it("handles missing error message", () => {
    const failures: EffectResult[] = [
      { effect: { type: "close_issue", issueNumber: 1 }, success: false, retried: true },
    ];
    const comment = buildReconciliationComment(failures)!;
    expect(comment).toContain("unknown error");
  });
});
