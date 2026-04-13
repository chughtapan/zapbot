import { Kysely } from "kysely";
import type { Database } from "../store/database.js";
import { getStaleAgents, updateAgentStatus } from "../store/queries.js";
import { createLogger } from "../logger.js";

const log = createLogger("heartbeat");

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const TIMEOUT_SECONDS = 15 * 60; // 15 minutes

let intervalHandle: ReturnType<typeof setInterval> | null = null;

// Callback for agent failure recovery, set by bridge at startup
let _onAgentFailed: ((db: Kysely<Database>, agentId: string) => Promise<void>) | null = null;

export function setHeartbeatFailureHandler(fn: (db: Kysely<Database>, agentId: string) => Promise<void>): void {
  _onAgentFailed = fn;
}

/**
 * Start periodic checks for stale agents.
 * Agents with no heartbeat in 15 minutes are marked as timed out
 * and their workflows are notified via the failure handler.
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

        // Notify workflow about the failure
        if (_onAgentFailed) {
          await _onAgentFailed(db, agent.id);
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
