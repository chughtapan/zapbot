import { ParentState, SubState, STATE_TO_LABEL } from "./states.js";
import type { WorkflowEvent } from "./events.js";
import type { SideEffect } from "./effects.js";

export interface Workflow {
  id: string;
  issueNumber: number;
  state: string;
  level: "parent" | "sub";
  parentWorkflowId: string | null;
  draftReviewCycles: number;
}

export interface TransitionResult {
  newState: string;
  sideEffects: SideEffect[];
  transition: {
    from: string;
    to: string;
    event: string;
    triggeredBy: string;
  };
}

interface TransitionDef {
  from: string;
  eventType: string;
  to: string;
  guard?: (workflow: Workflow, event: WorkflowEvent) => boolean;
  effects: (workflow: Workflow, event: WorkflowEvent) => SideEffect[];
}

const MAX_DRAFT_REVIEW_CYCLES = 3;

// ── Label management helpers ────────────────────────────────────────

function labelSwap(issueNumber: number, fromState: string, toState: string): SideEffect[] {
  const effects: SideEffect[] = [];
  const oldLabel = STATE_TO_LABEL[fromState];
  const newLabel = STATE_TO_LABEL[toState];
  if (oldLabel) effects.push({ type: "remove_label", issueNumber, label: oldLabel });
  if (newLabel) effects.push({ type: "add_label", issueNumber, label: newLabel });
  return effects;
}

// ── Parent issue transitions ────────────────────────────────────────

const parentTransitions: TransitionDef[] = [
  {
    from: ParentState.TRIAGE,
    eventType: "triage_complete",
    to: ParentState.TRIAGED,
    effects: (wf) => [
      ...labelSwap(wf.issueNumber, ParentState.TRIAGE, ParentState.TRIAGED),
      { type: "post_comment", issueNumber: wf.issueNumber, body: "Triage complete. Sub-issues created and tracked." },
    ],
  },
  {
    from: ParentState.TRIAGED,
    eventType: "all_subs_done",
    to: ParentState.COMPLETED,
    effects: (wf) => [
      ...labelSwap(wf.issueNumber, ParentState.TRIAGED, ParentState.COMPLETED),
      { type: "close_issue", issueNumber: wf.issueNumber },
      { type: "post_comment", issueNumber: wf.issueNumber, body: "All sub-issues complete. Closing parent issue." },
    ],
  },
];

// ── Sub-issue transitions ───────────────────────────────────────────

const subTransitions: TransitionDef[] = [
  {
    from: SubState.PLANNING,
    eventType: "plan_published",
    to: SubState.REVIEW,
    effects: (wf) => labelSwap(wf.issueNumber, SubState.PLANNING, SubState.REVIEW),
  },
  {
    from: SubState.REVIEW,
    eventType: "label_added",
    to: SubState.IMPLEMENTING,
    guard: (_wf, event) => event.type === "label_added" && event.label === "plan-approved",
    effects: (wf) => [
      ...labelSwap(wf.issueNumber, SubState.REVIEW, SubState.IMPLEMENTING),
      { type: "spawn_agent", role: "implementer", issueNumber: wf.issueNumber },
    ],
  },
  {
    from: SubState.REVIEW,
    eventType: "annotation_feedback",
    to: SubState.PLANNING,
    effects: (wf) => [
      ...labelSwap(wf.issueNumber, SubState.REVIEW, SubState.PLANNING),
      { type: "post_comment", issueNumber: wf.issueNumber, body: "Feedback received. Revise the plan and re-publish." },
    ],
  },
  {
    from: SubState.IMPLEMENTING,
    eventType: "draft_pr_opened",
    to: SubState.DRAFT_REVIEW,
    effects: (wf) => [
      ...labelSwap(wf.issueNumber, SubState.IMPLEMENTING, SubState.DRAFT_REVIEW),
      { type: "post_comment", issueNumber: wf.issueNumber, body: "Draft PR opened. Review the changes and click \"Ready for review\" when satisfied." },
    ],
  },
  {
    from: SubState.DRAFT_REVIEW,
    eventType: "changes_requested",
    to: SubState.DRAFT_REVIEW,
    effects: (wf) => [
      { type: "post_comment", issueNumber: wf.issueNumber, body: "Changes requested on draft PR. Implementer agent is iterating." },
    ],
  },
  {
    from: SubState.DRAFT_REVIEW,
    eventType: "pr_ready_for_review",
    to: SubState.VERIFYING,
    effects: (wf) => [
      ...labelSwap(wf.issueNumber, SubState.DRAFT_REVIEW, SubState.VERIFYING),
      { type: "spawn_agent", role: "qe", issueNumber: wf.issueNumber },
    ],
  },
  {
    from: SubState.VERIFYING,
    eventType: "verified_and_shipped",
    to: SubState.DONE,
    effects: (wf) => [
      ...labelSwap(wf.issueNumber, SubState.VERIFYING, SubState.DONE),
      { type: "close_issue", issueNumber: wf.issueNumber },
      ...(wf.parentWorkflowId
        ? [{ type: "check_parent_completion" as const, parentWorkflowId: wf.parentWorkflowId }]
        : []),
    ],
  },
  {
    from: SubState.VERIFYING,
    eventType: "verification_failed",
    to: SubState.DRAFT_REVIEW,
    guard: (wf) => wf.draftReviewCycles < MAX_DRAFT_REVIEW_CYCLES,
    effects: (wf) => [
      ...labelSwap(wf.issueNumber, SubState.VERIFYING, SubState.DRAFT_REVIEW),
      { type: "post_comment", issueNumber: wf.issueNumber, body: `Verification failed. Returning to draft review (cycle ${wf.draftReviewCycles + 1}/${MAX_DRAFT_REVIEW_CYCLES}).` },
    ],
  },
  {
    from: SubState.VERIFYING,
    eventType: "verification_failed",
    to: SubState.ABANDONED,
    guard: (wf) => wf.draftReviewCycles >= MAX_DRAFT_REVIEW_CYCLES,
    effects: (wf) => [
      ...labelSwap(wf.issueNumber, SubState.VERIFYING, SubState.ABANDONED),
      { type: "post_comment", issueNumber: wf.issueNumber, body: `Verification failed after ${MAX_DRAFT_REVIEW_CYCLES} cycles. Abandoning — human intervention needed.` },
      { type: "notify_human", message: `Issue #${wf.issueNumber} abandoned after ${MAX_DRAFT_REVIEW_CYCLES} failed verification cycles.` },
      ...(wf.parentWorkflowId
        ? [{ type: "check_parent_completion" as const, parentWorkflowId: wf.parentWorkflowId }]
        : []),
    ],
  },
];

// ── Abandon transitions (any state) ────────────────────────────────

function buildAbandonTransitions(): TransitionDef[] {
  const allParentStates = [ParentState.TRIAGE, ParentState.TRIAGED];
  const allSubStates = [
    SubState.PLANNING, SubState.REVIEW, SubState.APPROVED,
    SubState.IMPLEMENTING, SubState.DRAFT_REVIEW, SubState.VERIFYING,
  ];

  const parentAbandons: TransitionDef[] = allParentStates.map((from) => ({
    from,
    eventType: "label_abandoned",
    to: ParentState.ABANDONED,
    effects: (wf: Workflow) => [
      ...labelSwap(wf.issueNumber, from, ParentState.ABANDONED),
      { type: "abandon_children", parentWorkflowId: wf.id },
      { type: "post_comment", issueNumber: wf.issueNumber, body: "Workflow abandoned." },
    ],
  }));

  const subAbandons: TransitionDef[] = allSubStates.map((from) => ({
    from,
    eventType: "label_abandoned",
    to: SubState.ABANDONED,
    effects: (wf: Workflow) => [
      ...labelSwap(wf.issueNumber, from, SubState.ABANDONED),
      { type: "post_comment", issueNumber: wf.issueNumber, body: "Sub-issue abandoned." },
      ...(wf.parentWorkflowId
        ? [{ type: "check_parent_completion" as const, parentWorkflowId: wf.parentWorkflowId }]
        : []),
    ],
  }));

  return [...parentAbandons, ...subAbandons];
}

export const ALL_TRANSITIONS: TransitionDef[] = [
  ...parentTransitions,
  ...subTransitions,
  ...buildAbandonTransitions(),
];

export function findTransition(
  workflow: Workflow,
  event: WorkflowEvent
): TransitionDef | null {
  for (const t of ALL_TRANSITIONS) {
    if (t.from !== workflow.state) continue;
    if (t.eventType !== event.type) continue;
    if (t.guard && !t.guard(workflow, event)) continue;
    return t;
  }
  return null;
}
