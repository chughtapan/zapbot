import { Kysely } from "kysely";
import type { Database } from "../store/database.js";
import { getStaleAgents, updateAgentStatus, getWorkflow, updateWorkflowState, addTransition } from "../store/queries.js";
import { createLogger } from "../logger.js";

const log = createLogger("heartbeat");

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const TIMEOUT_SECONDS = 15 * 60; // 15 minutes

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Start periodic checks for stale agents.
 * Agents with no heartbeat in 15 minutes are marked as timed out
 * and their workflows are notified.
 */
export function startHeartbeatChecker(db: Kysely<Database>): void {
  if (intervalHandle) return;

  log.info("Starting heartbeat checker", { intervalMs: CHECK_INTERVAL_MS, timeoutSec: TIMEOUT_SECONDS });

  intervalHandle = setInterval(async () => {
    try {
      const stale = await getStaleAgents(db, TIMEOUT_SECONDS);
      for (const agent of stale) {
        log.warn(`Agent ${agent.id} timed out (role=${agent.role}, workflow=${agent.workflow_id})`, {
          agentId: agent.id,
          role: agent.role,
          workflow: agent.workflow_id,
        });
        await updateAgentStatus(db, agent.id, "timeout");

        // Notify about the timeout by logging (side effects like GitHub comments
        // are handled by the bridge when it detects the workflow is stuck)
        const wf = await getWorkflow(db, agent.workflow_id);
        if (wf) {
          log.warn(`Workflow ${wf.id} has timed-out agent, may need human intervention`, {
            workflow: wf.id,
            state: wf.state,
            agent: agent.id,
          });
        }
      }
      if (stale.length > 0) {
        log.info(`Marked ${stale.length} stale agent(s) as timed out`);
      }
    } catch (err) {
      log.error(`Heartbeat check failed: ${err}`);
    }
  }, CHECK_INTERVAL_MS);
}

export function stopHeartbeatChecker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    log.info("Heartbeat checker stopped");
  }
}
