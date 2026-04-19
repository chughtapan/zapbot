/**
 * v2/orchestrator/control-event — shape GitHub-originated control input for the
 * persistent AO orchestrator session.
 *
 * Architect phase only: public surface, no implementation.
 */

import type {
  CommentId,
  DeliveryId,
  IssueNumber,
  ProjectName,
  RepoFullName,
  Result,
} from "../types.ts";
import { err, ok } from "../types.ts";

export interface OrchestratorControlEvent {
  readonly _tag: "GitHubControlEvent";
  readonly repo: RepoFullName;
  readonly projectName: ProjectName;
  readonly issue: IssueNumber;
  readonly commentId: CommentId;
  readonly deliveryId: DeliveryId;
  readonly commentBody: string;
  readonly triggeredBy: string;
}

export interface OrchestratorControlPrompt {
  readonly title: string;
  readonly body: string;
}

export type ControlEventShapeError = { readonly _tag: "PromptShapeInvalid"; readonly reason: string };

/**
 * Render the thin shim's GitHub control input into the prompt text delivered to
 * the persistent AO orchestrator session.
 */
export function toOrchestratorControlPrompt(
  event: OrchestratorControlEvent,
): Result<OrchestratorControlPrompt, ControlEventShapeError> {
  if (event.triggeredBy.trim().length === 0) {
    return err({ _tag: "PromptShapeInvalid", reason: "triggeredBy must be a non-empty string" });
  }
  if (event.commentBody.trim().length === 0) {
    return err({ _tag: "PromptShapeInvalid", reason: "commentBody must be a non-empty string" });
  }
  return ok({
    title: `GitHub control for ${event.repo}#${event.issue as number}`,
    body: [
      `You are the persistent AO orchestrator for project ${event.projectName as string}.`,
      `A GitHub control event was accepted by zapbot and must now be handled durably.`,
      "",
      `repo: ${event.repo as string}`,
      `issue: #${event.issue as number}`,
      `comment_id: ${event.commentId as number}`,
      `delivery_id: ${event.deliveryId as string}`,
      `triggered_by: @${event.triggeredBy.trim()}`,
      "",
      "Interpret the GitHub message directly. Do not rely on the webhook bridge having pre-classified it into a specific command.",
      "",
      "github_comment_body:",
      event.commentBody,
      "",
      "Publish durable artifacts back to GitHub. Use MoltZap only for live coordination.",
    ].join("\n"),
  });
}
