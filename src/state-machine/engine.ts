import type { WorkflowEvent } from "./events.js";
import type { SideEffect } from "./effects.js";
import { findTransition, type Workflow, type TransitionResult } from "./transitions.js";

/**
 * Pure function: given a workflow and an event, compute the new state and side effects.
 * Returns null if the event is not valid for the current state.
 */
export function apply(workflow: Workflow, event: WorkflowEvent): TransitionResult | null {
  const transition = findTransition(workflow, event);
  if (!transition) return null;

  const sideEffects: SideEffect[] = transition.effects(workflow, event);

  return {
    newState: transition.to,
    sideEffects,
    transition: {
      from: workflow.state,
      to: transition.to,
      event: event.type,
      triggeredBy: event.triggeredBy,
    },
  };
}
