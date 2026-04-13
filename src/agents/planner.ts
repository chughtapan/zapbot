import { Kysely } from "kysely";
import type { Database } from "../store/database.js";
import { getWorkflow, updateWorkflowState, addTransition, withTransaction } from "../store/queries.js";
import { createLogger } from "../logger.js";

const log = createLogger("planner-agent");

/**
 * After the planner agent drafts a plan and publishes it via zapbot-publish,
 * call this to transition the sub-issue from PLANNING to REVIEW.
 */
export async function completePlannerAgent(
  db: Kysely<Database>,
  workflowId: string,
  triggeredBy: string
): Promise<void> {
  const wf = await getWorkflow(db, workflowId);
  if (!wf || wf.state !== "PLANNING") {
    log.warn(`Cannot complete planner: workflow ${workflowId} is in ${wf?.state || "unknown"} state`);
    return;
  }

  await withTransaction(db, async (trx) => {
    await updateWorkflowState(trx, workflowId, "REVIEW");
    await addTransition(trx, {
      id: `t-${crypto.randomUUID()}`,
      workflow_id: workflowId,
      from_state: "PLANNING",
      to_state: "REVIEW",
      event_type: "plan_published",
      triggered_by: triggeredBy,
      metadata: null,
      github_delivery_id: null,
    });
  });

  log.info(`Plan published for ${workflowId}, now in REVIEW`, { workflowId });
}
