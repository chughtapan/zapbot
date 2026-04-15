import { Kysely } from "kysely";
import type { Database } from "../store/database.js";
import { getSessionsForCleanup, markSessionCleaned, getAgentSessions } from "../store/queries.js";
import { TERMINAL_STATES } from "../state-machine/states.js";
import { createLogger } from "../logger.js";

const log = createLogger("cleanup");

const KILL_TIMEOUT_MS = 10_000;

/**
 * Kill an AO session by name. Returns true if the kill succeeded (exit 0).
 * Swallows errors and returns false on failure or timeout.
 */
async function killSession(sessionName: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["ao", "session", "kill", sessionName], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeoutPromise = new Promise<number>((resolve) =>
      setTimeout(() => {
        proc.kill();
        resolve(-1);
      }, KILL_TIMEOUT_MS)
    );

    const exitCode = await Promise.race([proc.exited, timeoutPromise]);

    if (exitCode === 0) {
      log.info(`Killed session ${sessionName}`, { session: sessionName });
      return true;
    }

    const stderr = await new Response(proc.stderr).text().catch(() => "");
    log.warn(`ao session kill ${sessionName} exited with code ${exitCode}: ${stderr.trim()}`, {
      session: sessionName,
      exitCode,
    });
    return false;
  } catch (err) {
    log.warn(`Failed to kill session ${sessionName}: ${err}`, { session: sessionName });
    return false;
  }
}

/**
 * Find the AO session name for a given issue number by parsing `ao session ls` output.
 * Looks for lines containing the branch pattern `feat/issue-{N}`.
 */
async function findSessionNameForIssue(issueNumber: number): Promise<string | null> {
  const branch = `feat/issue-${issueNumber}`;

  for (const cmd of [["ao", "session", "ls"], ["ao", "status"]]) {
    try {
      const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      if (exitCode !== 0) continue;

      for (const line of stdout.split("\n")) {
        if (line.includes(branch)) {
          const match = line.match(/(zap-\d+)/);
          if (match) return match[1];
        }
      }
    } catch {
      // Command failed, try next
    }
  }

  return null;
}

/**
 * Clean up all agent sessions for a given workflow.
 * Kills the AO session and marks the agent session as cleaned.
 * Only marks cleaned_up_at on successful kill.
 */
export async function cleanupWorkflowSessions(
  db: Kysely<Database>,
  workflowId: string
): Promise<void> {
  const sessions = await getAgentSessions(db, workflowId);
  const uncleaned = sessions.filter((s) => s.cleaned_up_at === null);

  if (uncleaned.length === 0) return;

  log.info(`Cleaning up ${uncleaned.length} session(s) for workflow ${workflowId}`, {
    workflowId,
    count: uncleaned.length,
  });

  for (const session of uncleaned) {
    // Extract issue number from workflow ID (format: "wf-{issueNumber}")
    const issueMatch = workflowId.match(/^wf-(\d+)/);
    if (!issueMatch) {
      log.warn(`Cannot parse issue number from workflow ${workflowId}`, { workflowId });
      continue;
    }

    const issueNumber = parseInt(issueMatch[1], 10);
    const sessionName = await findSessionNameForIssue(issueNumber);

    if (!sessionName) {
      // Session not found in AO — it may already be dead. Mark as cleaned.
      log.info(`No AO session found for issue #${issueNumber}, marking as cleaned`, {
        agentId: session.id,
        issueNumber,
      });
      await markSessionCleaned(db, session.id);
      continue;
    }

    const killed = await killSession(sessionName);
    if (killed) {
      await markSessionCleaned(db, session.id);
    } else {
      log.warn(`Kill failed for ${sessionName}, will retry on next sweep`, {
        agentId: session.id,
        session: sessionName,
      });
    }
  }
}

/**
 * Periodic sweep: find all agent sessions where the parent workflow is in a
 * terminal state and the session hasn't been cleaned up yet.
 */
export async function cleanupStaleSessions(
  db: Kysely<Database>
): Promise<void> {
  const terminalStatesList = Array.from(TERMINAL_STATES);
  const stale = await getSessionsForCleanup(db, terminalStatesList);

  if (stale.length === 0) return;

  log.info(`Sweep found ${stale.length} stale session(s) to clean`, { count: stale.length });

  // Group by workflow to avoid duplicate AO lookups
  const byWorkflow = new Map<string, typeof stale>();
  for (const session of stale) {
    const list = byWorkflow.get(session.workflow_id) ?? [];
    list.push(session);
    byWorkflow.set(session.workflow_id, list);
  }

  for (const workflowId of byWorkflow.keys()) {
    try {
      await cleanupWorkflowSessions(db, workflowId);
    } catch (err) {
      log.error(`Cleanup failed for workflow ${workflowId}: ${err}`, { workflowId });
    }
  }
}
