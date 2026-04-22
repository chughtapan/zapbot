import type { EligibleMentionRequest } from "../github-control-request.ts";
import type { Result } from "../types.ts";

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
  throw new Error("not implemented");
}
