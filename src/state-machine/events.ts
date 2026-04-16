export type WorkflowEvent =
  | { type: "triage_complete"; triggeredBy: string; subIssueNumbers: number[] }
  | { type: "all_subs_done"; triggeredBy: string }
  | { type: "plan_published"; triggeredBy: string }
  | { type: "label_added"; label: string; triggeredBy: string }
  | { type: "annotation_feedback"; triggeredBy: string }
  | { type: "spawn_agent"; triggeredBy: string }
  | { type: "draft_pr_opened"; triggeredBy: string; prNumber: number }
  | { type: "non_draft_pr_opened"; triggeredBy: string; prNumber: number }
  | { type: "changes_requested"; triggeredBy: string }
  | { type: "pr_ready_for_review"; triggeredBy: string; prNumber: number }
  | { type: "verified_and_shipped"; triggeredBy: string }
  | { type: "verification_failed"; triggeredBy: string }
  | { type: "label_abandoned"; triggeredBy: string }
  | { type: "triage_label_added"; triggeredBy: string }
  | { type: "label_state_override"; label: string; targetState: string; triggeredBy: string }
  | { type: "issue_closed_externally"; triggeredBy: string }
  | { type: "mention_command"; command: string; body: string; issueNumber: number; triggeredBy: string; commentId: number };
