import { Kysely } from "kysely";
import type { Database, AgentSessionTable } from "../store/database.js";
import { getStaleAgents, updateAgentStatus, incrementNudgeCount, getWorkflow } from "../store/queries.js";
import type { AgentFailureHandler } from "./spawner.js";
import { findSessionForIssue } from "./session-lookup.js";
import { createLogger } from "../logger.js";

const log = createLogger("heartbeat");

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const TIMEOUT_SECONDS = 15 * 60; // 15 minutes
const MAX_NUDGES = 2;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let isChecking = false;

export type NudgeFn = (db: Kysely<Database>, agent: AgentSessionTable) => Promise<boolean>;

/**
 * Check if the agent process is still alive inside the tmux session.
 * Returns true if the shell has child processes (agent is running).
 */
async function isProcessAlive(sessionName: string): Promise<boolean> {
  try {
    const paneProc = Bun.spawn(["tmux", "list-panes", "-t", sessionName, "-F", "#{pane_pid}"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const panePid = (await new Response(paneProc.stdout).text()).trim();
    const paneExit = await paneProc.exited;
    if (paneExit !== 0 || !panePid) return false;

    const pgrepProc = Bun.spawn(["pgrep", "-P", panePid], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const pgrepExit = await pgrepProc.exited;
    return pgrepExit === 0;
  } catch {
    return false;
  }
}

/**
 * Attempt to nudge a stale agent by sending "continue" to its tmux session.
 * Returns true if the nudge was sent successfully.
 */
export async function nudgeAgent(db: Kysely<Database>, agent: AgentSessionTable): Promise<boolean> {
  const wf = await getWorkflow(db, agent.workflow_id);
  if (!wf) {
    log.warn(`Cannot nudge agent ${agent.id}: workflow ${agent.workflow_id} not found`, {
      agentId: agent.id,
    });
    return false;
  }

  const sessionName = await findSessionForIssue(wf.issue_number);
  if (!sessionName) {
    log.warn(`Cannot nudge agent ${agent.id}: no AO session found for issue #${wf.issue_number}`, {
      agentId: agent.id,
      issueNumber: wf.issue_number,
    });
    return false;
  }

  const alive = await isProcessAlive(sessionName);
  if (!alive) {
    log.warn(`Agent ${agent.id} process is dead in session ${sessionName}, skipping nudge`, {
      agentId: agent.id,
      session: sessionName,
    });
    return false;
  }

  try {
    log.info(`Nudging agent ${agent.id} via ${sessionName} (nudge ${agent.nudge_count + 1}/${MAX_NUDGES})`, {
      agentId: agent.id,
      session: sessionName,
      nudgeCount: agent.nudge_count + 1,
      maxNudges: MAX_NUDGES,
    });

    const proc = Bun.spawn(["tmux", "send-keys", "-t", sessionName, "continue", "Enter"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      log.warn(`tmux send-keys to ${sessionName} failed (code ${exitCode})`, {
        agentId: agent.id,
        session: sessionName,
      });
      return false;
    }

    await incrementNudgeCount(db, agent.id);
    return true;
  } catch (err) {
    log.error(`Nudge failed for agent ${agent.id}: ${err}`, {
      agentId: agent.id,
      session: sessionName,
    });
    return false;
  }
}

/**
 * Start periodic checks for stale agents.
 * Agents with no heartbeat in 15 minutes are first nudged (up to MAX_NUDGES times),
 * then marked as timed out if nudges are exhausted or fail.
 */
export function startHeartbeatChecker(
  db: Kysely<Database>,
  onAgentFailed?: AgentFailureHandler,
  nudgeFn?: NudgeFn
): void {
  const doNudge = nudgeFn ?? nudgeAgent;

  if (intervalHandle) {
    log.warn("Heartbeat checker already running, stopping old one");
    clearInterval(intervalHandle);
    intervalHandle = null;
  }

  log.info("Starting heartbeat checker", { intervalMs: CHECK_INTERVAL_MS, timeoutSec: TIMEOUT_SECONDS });

  intervalHandle = setInterval(async () => {
    if (isChecking) return;
    isChecking = true;
    try {
      const stale = await getStaleAgents(db, TIMEOUT_SECONDS);
      let nudgedCount = 0;
      let timedOutCount = 0;

      for (const agent of stale) {
        if (agent.nudge_count < MAX_NUDGES) {
          const nudged = await doNudge(db, agent);
          if (nudged) {
            nudgedCount++;
            continue;
          }
        }

        log.warn(`Agent ${agent.id} timed out after ${agent.nudge_count} nudge(s) (role=${agent.role}, workflow=${agent.workflow_id})`, {
          agentId: agent.id,
          role: agent.role,
          workflow: agent.workflow_id,
          nudgeCount: agent.nudge_count,
        });
        await updateAgentStatus(db, agent.id, "timeout");
        timedOutCount++;

        if (onAgentFailed) {
          await onAgentFailed(db, agent.id);
        }
      }

      if (nudgedCount > 0) {
        log.info(`Nudged ${nudgedCount} stale agent(s)`);
      }
      if (timedOutCount > 0) {
        log.info(`Marked ${timedOutCount} stale agent(s) as timed out`);
      }
    } catch (err) {
      log.error(`Heartbeat check failed: ${err}`);
    } finally {
      isChecking = false;
    }
  }, CHECK_INTERVAL_MS);
}

export function stopHeartbeatChecker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    isChecking = false;
    log.info("Heartbeat checker stopped");
  }
}
