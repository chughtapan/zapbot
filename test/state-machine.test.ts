import { describe, it, expect } from "vitest";
import { apply } from "../src/state-machine/engine.js";
import { ParentState, SubState } from "../src/state-machine/states.js";
import type { Workflow } from "../src/state-machine/transitions.js";
import type { WorkflowEvent } from "../src/state-machine/events.js";

function makeParent(state: string, overrides?: Partial<Workflow>): Workflow {
  return {
    id: "wf-10",
    issueNumber: 10,
    state,
    level: "parent",
    parentWorkflowId: null,
    draftReviewCycles: 0,
    ...overrides,
  };
}

function makeSub(state: string, overrides?: Partial<Workflow>): Workflow {
  return {
    id: "wf-11",
    issueNumber: 11,
    state,
    level: "sub",
    parentWorkflowId: "wf-10",
    draftReviewCycles: 0,
    ...overrides,
  };
}

// ── Parent issue transitions ────────────────────────────────────────

describe("parent issue transitions", () => {
  it("TRIAGE -> TRIAGED on triage_complete", () => {
    const wf = makeParent(ParentState.TRIAGE);
    const result = apply(wf, { type: "triage_complete", triggeredBy: "triage-agent", subIssueNumbers: [11, 12] });
    expect(result).not.toBeNull();
    expect(result!.newState).toBe(ParentState.TRIAGED);
    expect(result!.sideEffects.some((e) => e.type === "remove_label" && e.label === "triage")).toBe(true);
    expect(result!.sideEffects.some((e) => e.type === "add_label" && e.label === "triaged")).toBe(true);
  });

  it("TRIAGED -> COMPLETED on all_subs_done", () => {
    const wf = makeParent(ParentState.TRIAGED);
    const result = apply(wf, { type: "all_subs_done", triggeredBy: "system" });
    expect(result).not.toBeNull();
    expect(result!.newState).toBe(ParentState.COMPLETED);
    expect(result!.sideEffects.some((e) => e.type === "close_issue")).toBe(true);
  });

  it("rejects triage_complete when already TRIAGED", () => {
    const wf = makeParent(ParentState.TRIAGED);
    const result = apply(wf, { type: "triage_complete", triggeredBy: "agent", subIssueNumbers: [] });
    expect(result).toBeNull();
  });

  it("TRIAGE -> ABANDONED on label_abandoned", () => {
    const wf = makeParent(ParentState.TRIAGE);
    const result = apply(wf, { type: "label_abandoned", triggeredBy: "alice" });
    expect(result).not.toBeNull();
    expect(result!.newState).toBe(ParentState.ABANDONED);
    expect(result!.sideEffects.some((e) => e.type === "abandon_children")).toBe(true);
  });

  it("TRIAGED -> ABANDONED on label_abandoned", () => {
    const wf = makeParent(ParentState.TRIAGED);
    const result = apply(wf, { type: "label_abandoned", triggeredBy: "alice" });
    expect(result).not.toBeNull();
    expect(result!.newState).toBe(ParentState.ABANDONED);
  });

  it("rejects abandon on already-abandoned parent", () => {
    const wf = makeParent(ParentState.ABANDONED);
    const result = apply(wf, { type: "label_abandoned", triggeredBy: "alice" });
    expect(result).toBeNull();
  });

  it("rejects abandon on COMPLETED parent", () => {
    const wf = makeParent(ParentState.COMPLETED);
    const result = apply(wf, { type: "label_abandoned", triggeredBy: "alice" });
    expect(result).toBeNull();
  });
});

// ── Sub-issue transitions ───────────────────────────────────────────

describe("sub-issue transitions", () => {
  it("PLANNING -> REVIEW on plan_published", () => {
    const wf = makeSub(SubState.PLANNING);
    const result = apply(wf, { type: "plan_published", triggeredBy: "alice" });
    expect(result).not.toBeNull();
    expect(result!.newState).toBe(SubState.REVIEW);
    expect(result!.sideEffects.some((e) => e.type === "add_label" && e.label === "review")).toBe(true);
  });

  it("REVIEW -> APPROVED on label plan-approved", () => {
    const wf = makeSub(SubState.REVIEW);
    const result = apply(wf, { type: "label_added", label: "plan-approved", triggeredBy: "reviewer" });
    expect(result).not.toBeNull();
    expect(result!.newState).toBe(SubState.APPROVED);
    expect(result!.sideEffects.some((e) => e.type === "spawn_agent" && e.role === "implementer")).toBe(true);
  });

  it("rejects plan-approved label from PLANNING state", () => {
    const wf = makeSub(SubState.PLANNING);
    const result = apply(wf, { type: "label_added", label: "plan-approved", triggeredBy: "reviewer" });
    expect(result).toBeNull();
  });

  it("rejects non-plan-approved labels in REVIEW", () => {
    const wf = makeSub(SubState.REVIEW);
    const result = apply(wf, { type: "label_added", label: "some-other-label", triggeredBy: "reviewer" });
    expect(result).toBeNull();
  });

  it("REVIEW -> PLANNING on annotation_feedback", () => {
    const wf = makeSub(SubState.REVIEW);
    const result = apply(wf, { type: "annotation_feedback", triggeredBy: "reviewer" });
    expect(result).not.toBeNull();
    expect(result!.newState).toBe(SubState.PLANNING);
  });

  it("APPROVED -> IMPLEMENTING on spawn_agent", () => {
    const wf = makeSub(SubState.APPROVED);
    const result = apply(wf, { type: "spawn_agent", triggeredBy: "system" });
    expect(result).not.toBeNull();
    expect(result!.newState).toBe(SubState.IMPLEMENTING);
    expect(result!.sideEffects.some((e) => e.type === "spawn_agent" && e.role === "implementer")).toBe(true);
  });

  it("IMPLEMENTING -> DRAFT_REVIEW on draft_pr_opened", () => {
    const wf = makeSub(SubState.IMPLEMENTING);
    const result = apply(wf, { type: "draft_pr_opened", triggeredBy: "agent", prNumber: 42 });
    expect(result).not.toBeNull();
    expect(result!.newState).toBe(SubState.DRAFT_REVIEW);
  });

  it("DRAFT_REVIEW -> DRAFT_REVIEW on changes_requested (self-loop)", () => {
    const wf = makeSub(SubState.DRAFT_REVIEW);
    const result = apply(wf, { type: "changes_requested", triggeredBy: "reviewer" });
    expect(result).not.toBeNull();
    expect(result!.newState).toBe(SubState.DRAFT_REVIEW);
  });

  it("DRAFT_REVIEW -> VERIFYING on pr_ready_for_review", () => {
    const wf = makeSub(SubState.DRAFT_REVIEW);
    const result = apply(wf, { type: "pr_ready_for_review", triggeredBy: "author", prNumber: 42 });
    expect(result).not.toBeNull();
    expect(result!.newState).toBe(SubState.VERIFYING);
    expect(result!.sideEffects.some((e) => e.type === "spawn_agent" && e.role === "qe")).toBe(true);
  });

  it("VERIFYING -> DONE on verified_and_shipped", () => {
    const wf = makeSub(SubState.VERIFYING);
    const result = apply(wf, { type: "verified_and_shipped", triggeredBy: "qe-agent" });
    expect(result).not.toBeNull();
    expect(result!.newState).toBe(SubState.DONE);
    expect(result!.sideEffects.some((e) => e.type === "close_issue")).toBe(true);
    expect(result!.sideEffects.some((e) => e.type === "check_parent_completion")).toBe(true);
  });

  it("VERIFYING -> DRAFT_REVIEW on verification_failed (under limit)", () => {
    const wf = makeSub(SubState.VERIFYING, { draftReviewCycles: 1 });
    const result = apply(wf, { type: "verification_failed", triggeredBy: "qe-agent" });
    expect(result).not.toBeNull();
    expect(result!.newState).toBe(SubState.DRAFT_REVIEW);
  });

  it("VERIFYING -> ABANDONED on verification_failed (at limit)", () => {
    const wf = makeSub(SubState.VERIFYING, { draftReviewCycles: 3 });
    const result = apply(wf, { type: "verification_failed", triggeredBy: "qe-agent" });
    expect(result).not.toBeNull();
    expect(result!.newState).toBe(SubState.ABANDONED);
    expect(result!.sideEffects.some((e) => e.type === "notify_human")).toBe(true);
    expect(result!.sideEffects.some((e) => e.type === "check_parent_completion")).toBe(true);
  });
});

// ── Sub-issue abandon ───────────────────────────────────────────────

describe("sub-issue abandon transitions", () => {
  const nonTerminalStates = [
    SubState.PLANNING,
    SubState.REVIEW,
    SubState.APPROVED,
    SubState.IMPLEMENTING,
    SubState.DRAFT_REVIEW,
    SubState.VERIFYING,
  ];

  for (const state of nonTerminalStates) {
    it(`${state} -> ABANDONED on label_abandoned`, () => {
      const wf = makeSub(state);
      const result = apply(wf, { type: "label_abandoned", triggeredBy: "author" });
      expect(result).not.toBeNull();
      expect(result!.newState).toBe(SubState.ABANDONED);
      expect(result!.sideEffects.some((e) => e.type === "check_parent_completion")).toBe(true);
    });
  }

  it("rejects abandon on already-DONE sub-issue", () => {
    const wf = makeSub(SubState.DONE);
    const result = apply(wf, { type: "label_abandoned", triggeredBy: "author" });
    expect(result).toBeNull();
  });

  it("rejects abandon on already-ABANDONED sub-issue", () => {
    const wf = makeSub(SubState.ABANDONED);
    const result = apply(wf, { type: "label_abandoned", triggeredBy: "author" });
    expect(result).toBeNull();
  });
});

// ── Edge cases ──────────────────────────────────────────────────────

describe("edge cases", () => {
  it("DONE sub-issue has no check_parent_completion when no parent", () => {
    const wf = makeSub(SubState.VERIFYING, { parentWorkflowId: null });
    const result = apply(wf, { type: "verified_and_shipped", triggeredBy: "qe" });
    expect(result).not.toBeNull();
    expect(result!.sideEffects.some((e) => e.type === "check_parent_completion")).toBe(false);
  });

  it("label_added for non-plan-approved does nothing in REVIEW", () => {
    const wf = makeSub(SubState.REVIEW);
    const result = apply(wf, { type: "label_added", label: "bug", triggeredBy: "anyone" });
    expect(result).toBeNull();
  });

  it("draft_review_cycles boundary at exactly 3", () => {
    // cycles=2 should still allow one more
    const wf2 = makeSub(SubState.VERIFYING, { draftReviewCycles: 2 });
    const result2 = apply(wf2, { type: "verification_failed", triggeredBy: "qe" });
    expect(result2!.newState).toBe(SubState.DRAFT_REVIEW);

    // cycles=3 should abandon
    const wf3 = makeSub(SubState.VERIFYING, { draftReviewCycles: 3 });
    const result3 = apply(wf3, { type: "verification_failed", triggeredBy: "qe" });
    expect(result3!.newState).toBe(SubState.ABANDONED);
  });

  it("APPROVED -> IMPLEMENTING spawns implementer agent", () => {
    const wf = makeSub(SubState.APPROVED);
    const result = apply(wf, { type: "spawn_agent", triggeredBy: "system" });
    const spawnEffects = result!.sideEffects.filter((e) => e.type === "spawn_agent");
    expect(spawnEffects).toHaveLength(1);
    expect((spawnEffects[0] as any).role).toBe("implementer");
  });

  it("REVIEW -> APPROVED spawns implementer agent as side effect", () => {
    const wf = makeSub(SubState.REVIEW);
    const result = apply(wf, { type: "label_added", label: "plan-approved", triggeredBy: "reviewer" });
    const spawnEffects = result!.sideEffects.filter((e) => e.type === "spawn_agent");
    expect(spawnEffects).toHaveLength(1);
    expect((spawnEffects[0] as any).role).toBe("implementer");
  });
});
