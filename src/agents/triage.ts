import { Kysely } from "kysely";
import type { Database } from "../store/database.js";
import { getWorkflow, upsertWorkflow, updateWorkflowState, addTransition } from "../store/queries.js";
import { withTransaction } from "../store/queries.js";
import { createLogger } from "../logger.js";
import { makeWorkflowId } from "../workflow-id.js";

const log = createLogger("triage-agent");

export interface TriageResult {
  subIssues: Array<{
    title: string;
    body: string;
  }>;
}

/**
 * After the triage agent finishes its analysis and creates sub-issues,
 * call this to transition the parent workflow to TRIAGED and register
 * the sub-issues as workflows.
 */
export async function completeTriageAgent(
  db: Kysely<Database>,
  parentWorkflowId: string,
  subIssueNumbers: number[],
  repo: string,
  triggeredBy: string
): Promise<void> {
  const parent = await getWorkflow(db, parentWorkflowId);
  if (!parent || parent.state !== "TRIAGE") {
    log.warn(`Cannot complete triage: parent ${parentWorkflowId} is in ${parent?.state || "unknown"} state`);
    return;
  }

  await withTransaction(db, async (trx) => {
    // Register each sub-issue as a sub-workflow in PLANNING
    for (const issueNumber of subIssueNumbers) {
      const subId = makeWorkflowId(repo, issueNumber);
      await upsertWorkflow(trx, {
        id: subId,
        issue_number: issueNumber,
        repo,
        state: "PLANNING",
        level: "sub",
        parent_workflow_id: parentWorkflowId,
        author: parent.author,
        intent: "",
      });
    }

    // Transition parent to TRIAGED
    await updateWorkflowState(trx, parentWorkflowId, "TRIAGED");
    await addTransition(trx, {
      id: `t-${crypto.randomUUID()}`,
      workflow_id: parentWorkflowId,
      from_state: "TRIAGE",
      to_state: "TRIAGED",
      event_type: "triage_complete",
      triggered_by: triggeredBy,
      metadata: JSON.stringify({ sub_issues: subIssueNumbers }),
      github_delivery_id: null,
    });
  });

  log.info(`Triage complete for ${parentWorkflowId}: ${subIssueNumbers.length} sub-issues created`, {
    parent: parentWorkflowId,
    subIssues: subIssueNumbers,
  });
}
