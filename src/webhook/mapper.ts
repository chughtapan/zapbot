import type { WorkflowEvent } from "../state-machine/events.js";

const DEFAULT_BOT_USERNAME = "zapbot[bot]";

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
      return { event: { type: "triage_label_added" as any, triggeredBy: actor }, issueNumber, repo };
    }

    return null;
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

    // Look for linked issue in PR body (e.g., "Closes #11", "Part of #10")
    const issueMatch = body.match(/(?:closes|fixes|resolves|part of)\s+#(\d+)/i);
    if (!issueMatch) return null;
    const issueNumber = parseInt(issueMatch[1], 10);

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

    const issueMatch = body.match(/(?:closes|fixes|resolves|part of)\s+#(\d+)/i);
    if (!issueMatch) return null;
    const issueNumber = parseInt(issueMatch[1], 10);

    return { event: { type: "pr_ready_for_review", triggeredBy: actor, prNumber }, issueNumber, repo };
  }

  if (eventType === "pull_request" && payload.action === "closed" && payload.pull_request?.merged) {
    const body: string = payload.pull_request?.body || "";
    const actor: string = payload.sender?.login || "";

    const issueMatch = body.match(/(?:closes|fixes|resolves|part of)\s+#(\d+)/i);
    if (!issueMatch) return null;
    const issueNumber = parseInt(issueMatch[1], 10);

    return { event: { type: "verified_and_shipped", triggeredBy: actor }, issueNumber, repo };
  }

  if (eventType === "pull_request_review" && payload.action === "submitted") {
    const state: string = payload.review?.state || "";
    const body: string = payload.pull_request?.body || "";
    const actor: string = payload.sender?.login || "";

    if (state !== "changes_requested") return null;

    const issueMatch = body.match(/(?:closes|fixes|resolves|part of)\s+#(\d+)/i);
    if (!issueMatch) return null;
    const issueNumber = parseInt(issueMatch[1], 10);

    return { event: { type: "changes_requested", triggeredBy: actor }, issueNumber, repo };
  }

  return null;
}
