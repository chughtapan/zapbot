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

  it("REVIEW -> IMPLEMENTING on label plan-approved", () => {
    const wf = makeSub(SubState.REVIEW);
    const result = apply(wf, { type: "label_added", label: "plan-approved", triggeredBy: "reviewer" });
    expect(result).not.toBeNull();
    expect(result!.newState).toBe(SubState.IMPLEMENTING);
    expect(result!.sideEffects.some((e) => e.type === "spawn_agent" && e.role === "implementer")).toBe(true);
  });

  it("PLANNING -> IMPLEMENTING on label plan-approved", () => {
    const wf = makeSub(SubState.PLANNING);
    const result = apply(wf, { type: "label_added", label: "plan-approved", triggeredBy: "reviewer" });
    expect(result).not.toBeNull();
    expect(result!.newState).toBe(SubState.IMPLEMENTING);
    expect(result!.sideEffects.some((e) => e.type === "spawn_agent" && e.role === "implementer")).toBe(true);
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

  it("PLANNING -> IMPLEMENTING removes planning label and adds implementing label", () => {
    const wf = makeSub(SubState.PLANNING);
    const result = apply(wf, { type: "label_added", label: "plan-approved", triggeredBy: "reviewer" });
    expect(result).not.toBeNull();
    expect(result!.sideEffects.some((e) => e.type === "remove_label" && e.label === "planning")).toBe(true);
    expect(result!.sideEffects.some((e) => e.type === "add_label" && e.label === "implementing")).toBe(true);
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

  it("REVIEW -> IMPLEMENTING spawns exactly one implementer agent", () => {
    const wf = makeSub(SubState.REVIEW);
    const result = apply(wf, { type: "label_added", label: "plan-approved", triggeredBy: "reviewer" });
    const spawnEffects = result!.sideEffects.filter((e) => e.type === "spawn_agent");
    expect(spawnEffects).toHaveLength(1);
    expect((spawnEffects[0] as any).role).toBe("implementer");
  });

  it("PLANNING -> IMPLEMENTING spawns exactly one implementer agent", () => {
    const wf = makeSub(SubState.PLANNING);
    const result = apply(wf, { type: "label_added", label: "plan-approved", triggeredBy: "reviewer" });
    const spawnEffects = result!.sideEffects.filter((e) => e.type === "spawn_agent");
    expect(spawnEffects).toHaveLength(1);
    expect((spawnEffects[0] as any).role).toBe("implementer");
  });
});

// ── Additional coverage ────────────────────────────────────────────

describe("non_draft_pr_opened transition", () => {
  it("IMPLEMENTING -> VERIFYING on non_draft_pr_opened, spawns QE agent", () => {
    const wf = makeSub(SubState.IMPLEMENTING);
    const result = apply(wf, { type: "non_draft_pr_opened", triggeredBy: "agent", prNumber: 99 });
    expect(result).not.toBeNull();
    expect(result!.newState).toBe(SubState.VERIFYING);
    expect(result!.sideEffects.some((e) => e.type === "spawn_agent" && (e as any).role === "qe")).toBe(true);
    expect(result!.sideEffects.some((e) => e.type === "remove_label" && (e as any).label === "implementing")).toBe(true);
    expect(result!.sideEffects.some((e) => e.type === "add_label" && (e as any).label === "verifying")).toBe(true);
  });
});

describe("verification_failed cycle-based routing", () => {
  it("VERIFYING -> DRAFT_REVIEW when draftReviewCycles < 3", () => {
    const wf = makeSub(SubState.VERIFYING, { draftReviewCycles: 0 });
    const result = apply(wf, { type: "verification_failed", triggeredBy: "qe-agent" });
    expect(result).not.toBeNull();
    expect(result!.newState).toBe(SubState.DRAFT_REVIEW);
    expect(result!.sideEffects.some((e) => e.type === "remove_label" && (e as any).label === "verifying")).toBe(true);
    expect(result!.sideEffects.some((e) => e.type === "add_label" && (e as any).label === "draft-review")).toBe(true);
  });

  it("VERIFYING -> ABANDONED when draftReviewCycles >= 3", () => {
    const wf = makeSub(SubState.VERIFYING, { draftReviewCycles: 3 });
    const result = apply(wf, { type: "verification_failed", triggeredBy: "qe-agent" });
    expect(result).not.toBeNull();
    expect(result!.newState).toBe(SubState.ABANDONED);
    expect(result!.sideEffects.some((e) => e.type === "notify_human")).toBe(true);
    expect(result!.sideEffects.some((e) => e.type === "check_parent_completion")).toBe(true);
  });
});

describe("abandon from APPROVED state", () => {
  it("APPROVED -> ABANDONED on label_abandoned", () => {
    const wf = makeSub(SubState.APPROVED);
    const result = apply(wf, { type: "label_abandoned", triggeredBy: "author" });
    expect(result).not.toBeNull();
    expect(result!.newState).toBe(SubState.ABANDONED);
    expect(result!.sideEffects.some((e) => e.type === "check_parent_completion")).toBe(true);
    expect(result!.sideEffects.some((e) => e.type === "remove_label" && (e as any).label === "plan-approved")).toBe(true);
    expect(result!.sideEffects.some((e) => e.type === "add_label" && (e as any).label === "abandoned")).toBe(true);
  });
});

describe("parent abandon cascades", () => {
  it("TRIAGE -> ABANDONED produces abandon_children effect", () => {
    const wf = makeParent(ParentState.TRIAGE);
    const result = apply(wf, { type: "label_abandoned", triggeredBy: "alice" });
    expect(result).not.toBeNull();
    expect(result!.newState).toBe(ParentState.ABANDONED);
    const abandonEffect = result!.sideEffects.find((e) => e.type === "abandon_children");
    expect(abandonEffect).toBeDefined();
    expect((abandonEffect as any).parentWorkflowId).toBe("wf-10");
  });

  it("TRIAGED -> ABANDONED produces abandon_children effect", () => {
    const wf = makeParent(ParentState.TRIAGED);
    const result = apply(wf, { type: "label_abandoned", triggeredBy: "alice" });
    expect(result).not.toBeNull();
    expect(result!.newState).toBe(ParentState.ABANDONED);
    const abandonEffect = result!.sideEffects.find((e) => e.type === "abandon_children");
    expect(abandonEffect).toBeDefined();
    expect((abandonEffect as any).parentWorkflowId).toBe("wf-10");
  });
});

describe("DRAFT_REVIEW self-transition on changes_requested", () => {
  it("stays in DRAFT_REVIEW and posts comment", () => {
    const wf = makeSub(SubState.DRAFT_REVIEW);
    const result = apply(wf, { type: "changes_requested", triggeredBy: "reviewer" });
    expect(result).not.toBeNull();
    expect(result!.newState).toBe(SubState.DRAFT_REVIEW);
    expect(result!.transition.from).toBe(SubState.DRAFT_REVIEW);
    expect(result!.transition.to).toBe(SubState.DRAFT_REVIEW);
    expect(result!.sideEffects.some((e) => e.type === "post_comment")).toBe(true);
  });

  it("does not swap labels on self-transition", () => {
    const wf = makeSub(SubState.DRAFT_REVIEW);
    const result = apply(wf, { type: "changes_requested", triggeredBy: "reviewer" });
    expect(result).not.toBeNull();
    expect(result!.sideEffects.some((e) => e.type === "remove_label")).toBe(false);
    expect(result!.sideEffects.some((e) => e.type === "add_label")).toBe(false);
  });
});

// ── Label-based state override ─────────────────────────────────────

describe("label_state_override transitions", () => {
  const override = (targetState: string): WorkflowEvent => ({
    type: "label_state_override",
    label: "test",
    targetState,
    triggeredBy: "human",
  });

  it("moves sub-issue backwards: IMPLEMENTING → PLANNING", () => {
    const wf = makeSub(SubState.IMPLEMENTING);
    const result = apply(wf, override(SubState.PLANNING));
    expect(result).not.toBeNull();
    expect(result!.newState).toBe(SubState.PLANNING);
    expect(result!.transition.from).toBe(SubState.IMPLEMENTING);
    expect(result!.transition.to).toBe(SubState.PLANNING);
  });

  it("moves sub-issue backwards: REVIEW → PLANNING", () => {
    const wf = makeSub(SubState.REVIEW);
    const result = apply(wf, override(SubState.PLANNING));
    expect(result).not.toBeNull();
    expect(result!.newState).toBe(SubState.PLANNING);
  });

  it("moves sub-issue backwards: VERIFYING → IMPLEMENTING", () => {
    const wf = makeSub(SubState.VERIFYING);
    const result = apply(wf, override(SubState.IMPLEMENTING));
    expect(result).not.toBeNull();
    expect(result!.newState).toBe(SubState.IMPLEMENTING);
  });

  it("moves sub-issue forward: PLANNING → IMPLEMENTING", () => {
    const wf = makeSub(SubState.PLANNING);
    const result = apply(wf, override(SubState.IMPLEMENTING));
    expect(result).not.toBeNull();
    expect(result!.newState).toBe(SubState.IMPLEMENTING);
  });

  it("moves parent backward: TRIAGED → TRIAGE", () => {
    const wf = makeParent(ParentState.TRIAGED);
    const result = apply(wf, override(ParentState.TRIAGE));
    expect(result).not.toBeNull();
    expect(result!.newState).toBe(ParentState.TRIAGE);
  });

  it("rejects override to same state (no-op)", () => {
    const wf = makeSub(SubState.PLANNING);
    const result = apply(wf, override(SubState.PLANNING));
    expect(result).toBeNull();
  });

  it("swaps labels on override", () => {
    const wf = makeSub(SubState.IMPLEMENTING);
    const result = apply(wf, override(SubState.PLANNING))!;
    const removes = result.sideEffects.filter((e) => e.type === "remove_label");
    const adds = result.sideEffects.filter((e) => e.type === "add_label");
    expect(removes.length).toBe(1);
    expect(adds.length).toBe(1);
    expect((removes[0] as any).label).toBe("implementing");
    expect((adds[0] as any).label).toBe("planning");
  });

  it("posts a comment on override", () => {
    const wf = makeSub(SubState.REVIEW);
    const result = apply(wf, override(SubState.PLANNING))!;
    const comments = result.sideEffects.filter((e) => e.type === "post_comment");
    expect(comments.length).toBe(1);
    expect((comments[0] as any).body).toContain("manually moved");
    expect((comments[0] as any).body).toContain("@human");
  });

  it("spawns triage agent when overriding to TRIAGE", () => {
    const wf = makeParent(ParentState.TRIAGED);
    const result = apply(wf, override(ParentState.TRIAGE))!;
    const spawns = result.sideEffects.filter((e) => e.type === "spawn_agent");
    expect(spawns.length).toBe(1);
    expect((spawns[0] as any).role).toBe("triage");
  });

  it("spawns implementer agent when overriding to IMPLEMENTING", () => {
    const wf = makeSub(SubState.DRAFT_REVIEW);
    const result = apply(wf, override(SubState.IMPLEMENTING))!;
    const spawns = result.sideEffects.filter((e) => e.type === "spawn_agent");
    expect(spawns.length).toBe(1);
    expect((spawns[0] as any).role).toBe("implementer");
  });

  it("spawns QE agent when overriding to VERIFYING", () => {
    const wf = makeSub(SubState.IMPLEMENTING);
    const result = apply(wf, override(SubState.VERIFYING))!;
    const spawns = result.sideEffects.filter((e) => e.type === "spawn_agent");
    expect(spawns.length).toBe(1);
    expect((spawns[0] as any).role).toBe("qe");
  });

  it("does NOT spawn agent when overriding to PLANNING", () => {
    const wf = makeSub(SubState.IMPLEMENTING);
    const result = apply(wf, override(SubState.PLANNING))!;
    const spawns = result.sideEffects.filter((e) => e.type === "spawn_agent");
    expect(spawns.length).toBe(0);
  });

  it("does NOT spawn agent when overriding to REVIEW", () => {
    const wf = makeSub(SubState.IMPLEMENTING);
    const result = apply(wf, override(SubState.REVIEW))!;
    const spawns = result.sideEffects.filter((e) => e.type === "spawn_agent");
    expect(spawns.length).toBe(0);
  });
});

// ── External close (issue closed via GitHub UI) ────────────────────

describe("issue_closed_externally transitions", () => {
  const closeEvent: WorkflowEvent = { type: "issue_closed_externally", triggeredBy: "human" };

  it("closes sub-issue from PLANNING → DONE", () => {
    const wf = makeSub(SubState.PLANNING);
    const result = apply(wf, closeEvent);
    expect(result).not.toBeNull();
    expect(result!.newState).toBe(SubState.DONE);
  });

  it("closes sub-issue from IMPLEMENTING → DONE", () => {
    const wf = makeSub(SubState.IMPLEMENTING);
    const result = apply(wf, closeEvent);
    expect(result).not.toBeNull();
    expect(result!.newState).toBe(SubState.DONE);
  });

  it("closes sub-issue from VERIFYING → DONE", () => {
    const wf = makeSub(SubState.VERIFYING);
    const result = apply(wf, closeEvent);
    expect(result).not.toBeNull();
    expect(result!.newState).toBe(SubState.DONE);
  });

  it("closes parent from TRIAGE → COMPLETED", () => {
    const wf = makeParent(ParentState.TRIAGE);
    const result = apply(wf, closeEvent);
    expect(result).not.toBeNull();
    expect(result!.newState).toBe(ParentState.COMPLETED);
  });

  it("closes parent from TRIAGED → COMPLETED", () => {
    const wf = makeParent(ParentState.TRIAGED);
    const result = apply(wf, closeEvent);
    expect(result).not.toBeNull();
    expect(result!.newState).toBe(ParentState.COMPLETED);
  });

  it("checks parent completion when sub-issue is closed externally", () => {
    const wf = makeSub(SubState.IMPLEMENTING);
    const result = apply(wf, closeEvent)!;
    const checks = result.sideEffects.filter((e) => e.type === "check_parent_completion");
    expect(checks.length).toBe(1);
  });

  it("posts comment with @mention on external close", () => {
    const wf = makeSub(SubState.REVIEW);
    const result = apply(wf, closeEvent)!;
    const comments = result.sideEffects.filter((e) => e.type === "post_comment");
    expect(comments.length).toBe(1);
    expect((comments[0] as any).body).toContain("@human");
    expect((comments[0] as any).body).toContain("closed by");
  });
});
