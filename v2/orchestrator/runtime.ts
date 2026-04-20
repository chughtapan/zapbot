/**
 * v2/orchestrator/runtime — ensure the persistent AO orchestrator exists and
 * forward control prompts into it.
 *
 * Architect phase only: public surface, no implementation.
 */

import type { MoltzapSenderId } from "../moltzap/types.ts";
import type { AoSessionName, ProjectName, Result } from "../types.ts";
import { err, ok } from "../types.ts";
import type { OrchestratorControlPrompt } from "./control-event.ts";

export interface OrchestratorReady {
  readonly session: AoSessionName;
  readonly senderId: MoltzapSenderId;
  readonly mode: "reused" | "started";
}

export interface OrchestratorForwardReceipt {
  readonly session: AoSessionName;
  readonly senderId: MoltzapSenderId;
}

export type AoControlHostError =
  | { readonly _tag: "AoStartFailed"; readonly cause: string }
  | { readonly _tag: "OrchestratorNotFound"; readonly projectName: ProjectName }
  | { readonly _tag: "OrchestratorNotReady"; readonly projectName: ProjectName; readonly reason: string }
  | { readonly _tag: "AoSendFailed"; readonly cause: string };

export interface AoControlHost {
  readonly ensureStarted: (
    projectName: ProjectName,
  ) => Promise<Result<void, Extract<AoControlHostError, { readonly _tag: "AoStartFailed" }>>>;
  readonly resolveReady: (
    projectName: ProjectName,
  ) => Promise<
    Result<
      OrchestratorReady,
      | Extract<AoControlHostError, { readonly _tag: "OrchestratorNotFound" }>
      | Extract<AoControlHostError, { readonly _tag: "OrchestratorNotReady" }>
    >
  >;
  readonly sendPrompt: (
    session: AoSessionName,
    prompt: OrchestratorControlPrompt,
  ) => Promise<Result<void, Extract<AoControlHostError, { readonly _tag: "AoSendFailed" }>>>;
}

export type EnsureOrchestratorError =
  | Extract<AoControlHostError, { readonly _tag: "AoStartFailed" }>
  | Extract<AoControlHostError, { readonly _tag: "OrchestratorNotFound" }>
  | Extract<AoControlHostError, { readonly _tag: "OrchestratorNotReady" }>;

export type ForwardControlError = EnsureOrchestratorError | Extract<AoControlHostError, { readonly _tag: "AoSendFailed" }>;

/**
 * Ensure the persistent per-project orchestrator session exists and has a
 * discoverable MoltZap identity before any control prompt is forwarded.
 */
export async function ensureProjectOrchestrator(
  projectName: ProjectName,
  host: AoControlHost,
): Promise<Result<OrchestratorReady, EnsureOrchestratorError>> {
  const started = await host.ensureStarted(projectName);
  if (started._tag === "Err") {
    return err(started.error);
  }
  const ready = await host.resolveReady(projectName);
  if (ready._tag === "Err") {
    return err(ready.error);
  }
  return ok(ready.value);
}

/**
 * Deliver a rendered control prompt into the ready orchestrator session.
 */
export async function forwardControlPrompt(
  projectName: ProjectName,
  prompt: OrchestratorControlPrompt,
  host: AoControlHost,
): Promise<Result<OrchestratorForwardReceipt, ForwardControlError>> {
  const ready = await ensureProjectOrchestrator(projectName, host);
  if (ready._tag === "Err") {
    return ready;
  }
  const sent = await host.sendPrompt(ready.value.session, prompt);
  if (sent._tag === "Err") {
    return err(sent.error);
  }
  return ok({
    session: ready.value.session,
    senderId: ready.value.senderId,
  });
}
