import { Kysely } from "kysely";
import type { Database } from "../store/database.js";
import { getWorkflow, updateWorkflowState, addTransition, withTransaction } from "../store/queries.js";
import { createLogger } from "../logger.js";

const log = createLogger("qe-agent");

/**
 * Called when the QE agent finishes verification successfully.
 * The QE agent posts a "QE Approved" comment/label but does NOT merge directly —
 * branch protection rules are the merge gate.
 */
export async function completeQEVerification(
  db: Kysely<Database>,
  workflowId: string,
  passed: boolean,
  triggeredBy: string
): Promise<void> {
  const wf = await getWorkflow(db, workflowId);
  if (!wf || wf.state !== "VERIFYING") {
    log.warn(`Cannot complete QE: workflow ${workflowId} is in ${wf?.state || "unknown"} state`);
    return;
  }

  if (passed) {
    await withTransaction(db, async (trx) => {
      await updateWorkflowState(trx, workflowId, "DONE");
      await addTransition(trx, {
        id: `t-${crypto.randomUUID().slice(0, 8)}`,
        workflow_id: workflowId,
        from_state: "VERIFYING",
        to_state: "DONE",
        event_type: "verified_and_shipped",
        triggered_by: triggeredBy,
        metadata: null,
        github_delivery_id: null,
      });
    });
    log.info(`QE verification passed for ${workflowId}`, { workflowId });
  } else {
    const newCycles = wf.draft_review_cycles + 1;
    await withTransaction(db, async (trx) => {
      await updateWorkflowState(trx, workflowId, "DRAFT_REVIEW", {
        draft_review_cycles: newCycles,
      });
      await addTransition(trx, {
        id: `t-${crypto.randomUUID().slice(0, 8)}`,
        workflow_id: workflowId,
        from_state: "VERIFYING",
        to_state: "DRAFT_REVIEW",
        event_type: "verification_failed",
        triggered_by: triggeredBy,
        metadata: JSON.stringify({ cycles: newCycles }),
        github_delivery_id: null,
      });
    });
    log.info(`QE verification failed for ${workflowId} (cycle ${newCycles})`, { workflowId });
  }
}
