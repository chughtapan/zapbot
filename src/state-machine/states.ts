export enum ParentState {
  TRIAGE = "TRIAGE",
  TRIAGED = "TRIAGED",
  COMPLETED = "COMPLETED",
  ABANDONED = "ABANDONED",
}

export enum SubState {
  PLANNING = "PLANNING",
  REVIEW = "REVIEW",
  APPROVED = "APPROVED", // Transient: used for label mapping only, transitions skip to IMPLEMENTING
  IMPLEMENTING = "IMPLEMENTING",
  INVESTIGATING = "INVESTIGATING",
  DRAFT_REVIEW = "DRAFT_REVIEW",
  VERIFYING = "VERIFYING",
  DONE = "DONE",
  ABANDONED = "ABANDONED",
}

export const TERMINAL_STATES = new Set<string>([
  ParentState.COMPLETED,
  ParentState.ABANDONED,
  SubState.DONE,
  SubState.ABANDONED,
]);

export const STATE_TO_LABEL: Record<string, string> = {
  [ParentState.TRIAGE]: "triage",
  [ParentState.TRIAGED]: "triaged",
  [ParentState.ABANDONED]: "abandoned",
  [SubState.PLANNING]: "planning",
  [SubState.REVIEW]: "review",
  [SubState.APPROVED]: "plan-approved",
  [SubState.IMPLEMENTING]: "implementing",
  [SubState.INVESTIGATING]: "investigating",
  [SubState.DRAFT_REVIEW]: "draft-review",
  [SubState.VERIFYING]: "verifying",
  [SubState.ABANDONED]: "abandoned",
};

export const LABEL_TO_STATE: Record<string, string> = Object.fromEntries(
  Object.entries(STATE_TO_LABEL).map(([state, label]) => [label, state])
);
