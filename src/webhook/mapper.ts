import type { WorkflowEvent } from "../state-machine/events.js";
import { LABEL_TO_STATE } from "../state-machine/states.js";

const DEFAULT_BOT_USERNAME = "zapbot[bot]";
const LINKED_ISSUE_RE = /(?:closes|fixes|resolves|part of)\s+#(\d+)/i;
const DEPENDS_ON_RE = /depends on #(\d+)/gi;

function extractLinkedIssue(body: string): number | null {
  const match = body.match(LINKED_ISSUE_RE);
  return match ? parseInt(match[1], 10) : null;
}

/** Parse "Depends on #N" markers from an issue body. */
export function parseDependencies(body: string): number[] {
  const deps: number[] = [];
  let match;
  while ((match = DEPENDS_ON_RE.exec(body)) !== null) {
    deps.push(parseInt(match[1], 10));
  }
  DEPENDS_ON_RE.lastIndex = 0;
  return deps;
}

/**
 * Maps a GitHub webhook event + payload to a WorkflowEvent for the state machine.
 * Returns null if the webhook should be ignored (unknown event, self-loop, no linked issue, etc.).
 */
export function mapWebhookToEvent(
  eventType: string,
  payload: any,
  botUsername: string = DEFAULT_BOT_USERNAME
): { event: WorkflowEvent; issueNumber: number; repo: string } | null {
  const repo: string = payload.repository?.full_name || "";

  if (eventType === "issues" && payload.action === "labeled") {
    const label: string = payload.label?.name || "";
    const actor: string = payload.sender?.login || "";
    const issueNumber: number = payload.issue?.number;

    // Self-label loop prevention
    if (actor === botUsername) {
      return null;
    }

    if (label === "abandoned") {
      return { event: { type: "label_abandoned", triggeredBy: actor }, issueNumber, repo };
    }

    if (label === "plan-approved") {
      return { event: { type: "label_added", label, triggeredBy: actor }, issueNumber, repo };
    }

    if (label === "triage") {
      return { event: { type: "triage_label_added", triggeredBy: actor }, issueNumber, repo };
    }

    // Any other state-mapped label triggers a state override.
    // This lets humans move issues to any state by adding the label.
    const targetState = LABEL_TO_STATE[label];
    if (targetState) {
      return {
        event: { type: "label_state_override", label, targetState, triggeredBy: actor },
        issueNumber,
        repo,
      };
    }

    return null;
  }

  // Issue closed externally (via GitHub UI or by a user, not by zapbot's close_issue effect).
  // This moves the workflow to a terminal state so it's not re-spawned on restart.
  if (eventType === "issues" && payload.action === "closed") {
    const actor: string = payload.sender?.login || "";
    const issueNumber: number = payload.issue?.number;
    if (actor === botUsername) return null; // zapbot closed it via close_issue effect, already handled
    return { event: { type: "issue_closed_externally", triggeredBy: actor }, issueNumber, repo };
  }

  if (eventType === "issues" && payload.action === "opened") {
    return null;
  }

  if (eventType === "issue_comment" && payload.action === "created") {
    return null;
  }

  if (eventType === "pull_request" && payload.action === "opened") {
    const prNumber: number = payload.pull_request?.number;
    const isDraft: boolean = payload.pull_request?.draft || false;
    const body: string = payload.pull_request?.body || "";
    const actor: string = payload.sender?.login || "";

    const issueNumber = extractLinkedIssue(body);
    if (issueNumber === null) return null;

    if (isDraft) {
      return { event: { type: "draft_pr_opened", triggeredBy: actor, prNumber }, issueNumber, repo };
    } else {
      return { event: { type: "non_draft_pr_opened", triggeredBy: actor, prNumber }, issueNumber, repo };
    }
  }

  if (eventType === "pull_request" && payload.action === "ready_for_review") {
    const prNumber: number = payload.pull_request?.number;
    const body: string = payload.pull_request?.body || "";
    const actor: string = payload.sender?.login || "";

    const issueNumber = extractLinkedIssue(body);
    if (issueNumber === null) return null;

    return { event: { type: "pr_ready_for_review", triggeredBy: actor, prNumber }, issueNumber, repo };
  }

  if (eventType === "pull_request" && payload.action === "closed" && payload.pull_request?.merged) {
    const body: string = payload.pull_request?.body || "";
    const actor: string = payload.sender?.login || "";

    const issueNumber = extractLinkedIssue(body);
    if (issueNumber === null) return null;

    return { event: { type: "verified_and_shipped", triggeredBy: actor }, issueNumber, repo };
  }

  if (eventType === "pull_request_review" && payload.action === "submitted") {
    const state: string = payload.review?.state || "";
    const body: string = payload.pull_request?.body || "";
    const actor: string = payload.sender?.login || "";

    if (state !== "changes_requested") return null;

    const issueNumber = extractLinkedIssue(body);
    if (issueNumber === null) return null;

    return { event: { type: "changes_requested", triggeredBy: actor }, issueNumber, repo };
  }

  return null;
}
