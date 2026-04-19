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
  MentionCommand,
  ProjectName,
  RepoFullName,
  Result,
} from "../types.ts";

export type OrchestratorControlCommand = Extract<
  MentionCommand,
  { readonly kind: "plan_this" | "investigate_this" | "status" }
>;

export interface OrchestratorControlEvent {
  readonly _tag: "GitHubControlEvent";
  readonly repo: RepoFullName;
  readonly projectName: ProjectName;
  readonly issue: IssueNumber;
  readonly commentId: CommentId;
  readonly deliveryId: DeliveryId;
  readonly command: OrchestratorControlCommand;
  readonly triggeredBy: string;
}

export interface OrchestratorControlPrompt {
  readonly title: string;
  readonly body: string;
}

export type ControlEventShapeError =
  | { readonly _tag: "UnsupportedCommand"; readonly command: MentionCommand["kind"] }
  | { readonly _tag: "PromptShapeInvalid"; readonly reason: string };

/**
 * Render the thin shim's GitHub control input into the prompt text delivered to
 * the persistent AO orchestrator session.
 */
export function toOrchestratorControlPrompt(
  event: OrchestratorControlEvent,
): Result<OrchestratorControlPrompt, ControlEventShapeError> {
  throw new Error("not implemented");
}
