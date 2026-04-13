export type SideEffect =
  | { type: "spawn_agent"; role: "triage" | "planner" | "implementer" | "qe"; issueNumber: number }
  | { type: "add_label"; issueNumber: number; label: string }
  | { type: "remove_label"; issueNumber: number; label: string }
  | { type: "post_comment"; issueNumber: number; body: string }
  | { type: "create_sub_issue"; parentIssueNumber: number; title: string; body: string }
  | { type: "close_issue"; issueNumber: number }
  | { type: "convert_pr_to_draft"; prNumber: number }
  | { type: "check_parent_completion"; parentWorkflowId: string }
  | { type: "abandon_children"; parentWorkflowId: string }
  | { type: "notify_human"; message: string };
