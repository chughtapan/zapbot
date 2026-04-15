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
  to: string | ((workflow: Workflow, event: WorkflowEvent) => string);
  guard?: (workflow: Workflow, event: WorkflowEvent) => boolean;
  effects: (workflow: Workflow, event: WorkflowEvent) => SideEffect[];
}

/** Resolve a static or dynamic `to` field. */
export function resolveTo(def: TransitionDef, workflow: Workflow, event: WorkflowEvent): string {
  return typeof def.to === "function" ? def.to(workflow, event) : def.to;
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
      { type: "post_comment", issueNumber: wf.issueNumber, body: "**Zapbot:** Triage complete. Sub-issues have been created and are being tracked. Each sub-issue will follow its own lifecycle: planning, review, implementation, and verification." },
    ],
  },
  {
    from: ParentState.TRIAGED,
    eventType: "all_subs_done",
    to: ParentState.COMPLETED,
    effects: (wf) => [
      ...labelSwap(wf.issueNumber, ParentState.TRIAGED, ParentState.COMPLETED),
      { type: "close_issue", issueNumber: wf.issueNumber },
      { type: "post_comment", issueNumber: wf.issueNumber, body: "**Zapbot:** All sub-issues are complete. Closing this parent issue. Nice work." },
    ],
  },
];

// ── Sub-issue transitions ───────────────────────────────────────────

const subTransitions: TransitionDef[] = [
  {
    from: SubState.PLANNING,
    eventType: "plan_published",
    to: SubState.REVIEW,
    effects: (wf) => [
      ...labelSwap(wf.issueNumber, SubState.PLANNING, SubState.REVIEW),
      { type: "post_comment", issueNumber: wf.issueNumber, body: "**Zapbot:** Plan published and ready for review. Add the `plan-approved` label when you're satisfied with the plan." },
    ],
  },
  {
    from: SubState.PLANNING,
    eventType: "label_added",
    to: SubState.IMPLEMENTING,
    guard: (_wf, event) => event.type === "label_added" && event.label === "plan-approved",
    effects: (wf, event) => [
      ...labelSwap(wf.issueNumber, SubState.PLANNING, SubState.IMPLEMENTING),
      { type: "spawn_agent", role: "implementer", issueNumber: wf.issueNumber },
      { type: "post_comment", issueNumber: wf.issueNumber, body: `**Zapbot:** Plan approved by @${event.triggeredBy}. Spawning implementer agent to write the code.` },
    ],
  },
  {
    from: SubState.REVIEW,
    eventType: "label_added",
    to: SubState.IMPLEMENTING,
    guard: (_wf, event) => event.type === "label_added" && event.label === "plan-approved",
    effects: (wf, event) => [
      ...labelSwap(wf.issueNumber, SubState.REVIEW, SubState.IMPLEMENTING),
      { type: "spawn_agent", role: "implementer", issueNumber: wf.issueNumber },
      { type: "post_comment", issueNumber: wf.issueNumber, body: `**Zapbot:** Plan approved by @${event.triggeredBy}. Spawning implementer agent to write the code.` },
    ],
  },
  {
    from: SubState.REVIEW,
    eventType: "annotation_feedback",
    to: SubState.PLANNING,
    effects: (wf) => [
      ...labelSwap(wf.issueNumber, SubState.REVIEW, SubState.PLANNING),
      { type: "post_comment", issueNumber: wf.issueNumber, body: "**Zapbot:** Feedback received on the plan. Moving back to planning. Revise the plan based on the review comments and re-publish when ready." },
    ],
  },
  {
    from: SubState.IMPLEMENTING,
    eventType: "draft_pr_opened",
    to: SubState.DRAFT_REVIEW,
    effects: (wf) => [
      ...labelSwap(wf.issueNumber, SubState.IMPLEMENTING, SubState.DRAFT_REVIEW),
      { type: "post_comment", issueNumber: wf.issueNumber, body: "**Zapbot:** Draft PR opened by the implementer agent. Review the changes, leave comments, and click **Ready for review** when satisfied. The agent will iterate on any requested changes." },
    ],
  },
  {
    from: SubState.IMPLEMENTING,
    eventType: "non_draft_pr_opened",
    to: SubState.VERIFYING,
    effects: (wf) => [
      ...labelSwap(wf.issueNumber, SubState.IMPLEMENTING, SubState.VERIFYING),
      { type: "spawn_agent", role: "qe", issueNumber: wf.issueNumber },
      { type: "post_comment", issueNumber: wf.issueNumber, body: "**Zapbot:** PR opened (non-draft). Spawning QE agent to run tests and verify the implementation." },
    ],
  },
  {
    from: SubState.DRAFT_REVIEW,
    eventType: "changes_requested",
    to: SubState.DRAFT_REVIEW,
    effects: (wf) => [
      { type: "post_comment", issueNumber: wf.issueNumber, body: "**Zapbot:** Changes requested on the draft PR. The implementer agent is reviewing your feedback and iterating." },
    ],
  },
  {
    from: SubState.DRAFT_REVIEW,
    eventType: "pr_ready_for_review",
    to: SubState.VERIFYING,
    effects: (wf) => [
      ...labelSwap(wf.issueNumber, SubState.DRAFT_REVIEW, SubState.VERIFYING),
      { type: "spawn_agent", role: "qe", issueNumber: wf.issueNumber },
      { type: "post_comment", issueNumber: wf.issueNumber, body: "**Zapbot:** PR marked ready for review. Spawning QE agent to run tests, verify the implementation, and ship." },
    ],
  },
  {
    from: SubState.VERIFYING,
    eventType: "verified_and_shipped",
    to: SubState.DONE,
    effects: (wf) => [
      ...labelSwap(wf.issueNumber, SubState.VERIFYING, SubState.DONE),
      { type: "post_comment", issueNumber: wf.issueNumber, body: "**Zapbot:** Verified and shipped. PR merged, tests passing. Closing issue." },
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
      { type: "post_comment", issueNumber: wf.issueNumber, body: `**Zapbot:** Verification failed. Returning to draft review for another iteration (cycle ${wf.draftReviewCycles + 1}/${MAX_DRAFT_REVIEW_CYCLES}). The implementer agent will address the failures.` },
    ],
  },
  {
    from: SubState.VERIFYING,
    eventType: "verification_failed",
    to: SubState.ABANDONED,
    guard: (wf) => wf.draftReviewCycles >= MAX_DRAFT_REVIEW_CYCLES,
    effects: (wf) => [
      ...labelSwap(wf.issueNumber, SubState.VERIFYING, SubState.ABANDONED),
      { type: "post_comment", issueNumber: wf.issueNumber, body: `**Zapbot:** Verification failed after ${MAX_DRAFT_REVIEW_CYCLES} review cycles. Abandoning this issue. A human needs to investigate and either fix the remaining failures or re-open with a revised plan.` },
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
      { type: "post_comment", issueNumber: wf.issueNumber, body: "**Zapbot:** Workflow abandoned. All child sub-issues will also be abandoned." },
    ],
  }));

  const subAbandons: TransitionDef[] = allSubStates.map((from) => ({
    from,
    eventType: "label_abandoned",
    to: SubState.ABANDONED,
    effects: (wf: Workflow) => [
      ...labelSwap(wf.issueNumber, from, SubState.ABANDONED),
      { type: "post_comment", issueNumber: wf.issueNumber, body: "**Zapbot:** Sub-issue abandoned. Any running agents for this issue will be stopped." },
      ...(wf.parentWorkflowId
        ? [{ type: "check_parent_completion" as const, parentWorkflowId: wf.parentWorkflowId }]
        : []),
    ],
  }));

  return [...parentAbandons, ...subAbandons];
}

// ── Label-based state override (human can move to any state) ──────

/** States that require spawning an agent when entered via override. */
const AGENT_SPAWN_STATES: Record<string, "triage" | "implementer" | "qe"> = {
  [ParentState.TRIAGE]: "triage",
  [SubState.IMPLEMENTING]: "implementer",
  [SubState.VERIFYING]: "qe",
};

function buildOverrideTransitions(): TransitionDef[] {
  // All non-terminal states that a human might want to override into
  const allParentStates = [ParentState.TRIAGE, ParentState.TRIAGED];
  const allSubStates = [
    SubState.PLANNING, SubState.REVIEW, SubState.IMPLEMENTING,
    SubState.DRAFT_REVIEW, SubState.VERIFYING,
  ];
  const allNonTerminal = [...allParentStates, ...allSubStates];

  return allNonTerminal.map((from) => ({
    from,
    eventType: "label_state_override",
    to: (_wf: Workflow, event: WorkflowEvent) => {
      if (event.type === "label_state_override") return event.targetState;
      return from; // should never happen
    },
    guard: (_wf: Workflow, event: WorkflowEvent) => {
      // Only fire if the target is different from current state
      if (event.type !== "label_state_override") return false;
      return event.targetState !== from;
    },
    effects: (wf: Workflow, event: WorkflowEvent) => {
      if (event.type !== "label_state_override") return [];
      const targetState = event.targetState;
      const effects: SideEffect[] = [
        ...labelSwap(wf.issueNumber, from, targetState),
        { type: "post_comment", issueNumber: wf.issueNumber,
          body: `**Zapbot:** @${event.triggeredBy} manually moved this issue from **${from}** to **${targetState}**.` },
      ];
      // Spawn agent if entering a state that needs one
      const role = AGENT_SPAWN_STATES[targetState];
      if (role) {
        effects.push({ type: "spawn_agent", role, issueNumber: wf.issueNumber });
      }
      return effects;
    },
  }));
}

// ── External close (issue closed via GitHub UI) ──────────────────

function buildExternalCloseTransitions(): TransitionDef[] {
  const allParentStates = [ParentState.TRIAGE, ParentState.TRIAGED];
  const allSubStates = [
    SubState.PLANNING, SubState.REVIEW, SubState.IMPLEMENTING,
    SubState.DRAFT_REVIEW, SubState.VERIFYING,
  ];

  const parentCloses: TransitionDef[] = allParentStates.map((from) => ({
    from,
    eventType: "issue_closed_externally",
    to: ParentState.COMPLETED,
    effects: (wf: Workflow, event: WorkflowEvent) => [
      ...labelSwap(wf.issueNumber, from, ParentState.COMPLETED),
      { type: "post_comment", issueNumber: wf.issueNumber,
        body: `**Zapbot:** Issue closed by @${event.triggeredBy}. Marking workflow as completed.` },
    ],
  }));

  const subCloses: TransitionDef[] = allSubStates.map((from) => ({
    from,
    eventType: "issue_closed_externally",
    to: SubState.DONE,
    effects: (wf: Workflow, event: WorkflowEvent) => [
      ...labelSwap(wf.issueNumber, from, SubState.DONE),
      { type: "post_comment", issueNumber: wf.issueNumber,
        body: `**Zapbot:** Issue closed by @${event.triggeredBy}. Marking workflow as done.` },
      ...(wf.parentWorkflowId
        ? [{ type: "check_parent_completion" as const, parentWorkflowId: wf.parentWorkflowId }]
        : []),
    ],
  }));

  return [...parentCloses, ...subCloses];
}

export const ALL_TRANSITIONS: TransitionDef[] = [
  ...parentTransitions,
  ...subTransitions,
  ...buildAbandonTransitions(),
  ...buildOverrideTransitions(),
  ...buildExternalCloseTransitions(),
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
