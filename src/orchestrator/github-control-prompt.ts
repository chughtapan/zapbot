import type { EligibleMentionRequest } from "../github-control-request.ts";
import type { Result } from "../types.ts";
import { err, ok } from "../types.ts";

export interface OrchestratorControlPrompt {
  readonly title: string;
  readonly body: string;
}

export type ControlPromptShapeError =
  | { readonly _tag: "PlacementMissing"; readonly reason: string }
  | { readonly _tag: "PromptShapeInvalid"; readonly reason: string };

export function toOrchestratorControlPrompt(
  request: EligibleMentionRequest,
): Result<OrchestratorControlPrompt, ControlPromptShapeError> {
  if ((request.placement.projectName as unknown as string).trim().length === 0) {
    return err({ _tag: "PlacementMissing", reason: "projectName must be present" });
  }
  if (request.triggeredBy.trim().length === 0) {
    return err({ _tag: "PromptShapeInvalid", reason: "triggeredBy must be a non-empty string" });
  }
  if (request.rawCommentBody.trim().length === 0) {
    return err({ _tag: "PromptShapeInvalid", reason: "rawCommentBody must be a non-empty string" });
  }
  const placement = request.placement;
  return ok({
    title: `GitHub control for ${placement.repo}#${placement.issue as number}`,
    body: [
      `You are the persistent AO orchestrator for project ${placement.projectName as string}.`,
      "A GitHub control event was accepted by zapbot and must now be handled durably.",
      "",
      `repo: ${placement.repo as string}`,
      `issue: #${placement.issue as number}`,
      `issue_thread_kind: ${placement.issueThreadKind}`,
      `issue_title: ${placement.issueTitle ?? "(none)"}`,
      `issue_url: ${placement.issueUrl ?? "(none)"}`,
      `comment_id: ${placement.commentId as number}`,
      `comment_url: ${placement.commentUrl ?? "(none)"}`,
      `delivery_id: ${placement.deliveryId as string}`,
      `triggered_by: @${request.triggeredBy.trim()}`,
      "",
      "Interpret the GitHub message directly. The webhook bridge has not classified it into a specific command.",
      "When you need a new worker session, use `bun run bin/ao-spawn-with-moltzap.ts <issue-number>` instead of plain `ao spawn` so the worker keeps its MoltZap control link back to you.",
      "",
      "github_comment_body:",
      request.rawCommentBody,
      "",
      "Publish durable artifacts back to GitHub. Use MoltZap only for live coordination.",
    ].join("\n"),
  });
}
