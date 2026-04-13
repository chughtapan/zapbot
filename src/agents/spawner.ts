import { Kysely } from "kysely";
import type { Database } from "../store/database.js";
import { createAgentSession, updateAgentStatus, getAgentSession, incrementRetryCount } from "../store/queries.js";
import { createLogger } from "../logger.js";

const log = createLogger("agents");

export type AgentRole = "triage" | "planner" | "implementer" | "qe";

export interface SpawnContext {
  issueNumber: number;
  repo: string;
  role: AgentRole;
  workflowId: string;
}

// Callback for when an agent permanently fails (all retries exhausted).
// Set by the bridge at startup so spawner can notify workflows.
let _onAgentFailed: ((db: Kysely<Database>, agentId: string) => Promise<void>) | null = null;

export function setOnAgentFailed(fn: (db: Kysely<Database>, agentId: string) => Promise<void>): void {
  _onAgentFailed = fn;
}

function generateAgentId(): string {
  return `agent-${crypto.randomUUID()}`;
}

function cleanStaleWorktree(issueNumber: number): void {
  const branch = `feat/issue-${issueNumber}`;
  try {
    const result = Bun.spawnSync(["git", "worktree", "list", "--porcelain"]);
    const stdout = new TextDecoder().decode(result.stdout);
    if (stdout.includes(branch)) {
      log.warn(`Removing stale worktree for ${branch}`, { issueNumber });
      // Find the worktree path from porcelain output
      const lines = stdout.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(branch)) {
          // The worktree path is on the "worktree <path>" line preceding the branch line
          for (let j = i; j >= 0; j--) {
            if (lines[j].startsWith("worktree ")) {
              const wtPath = lines[j].replace("worktree ", "");
              Bun.spawnSync(["git", "worktree", "remove", "--force", wtPath]);
              log.info(`Removed stale worktree at ${wtPath}`, { branch });
              break;
            }
          }
          break;
        }
      }
    }
  } catch (err) {
    log.warn(`Failed to clean stale worktree for ${branch}: ${err}`, { issueNumber });
  }
}

/**
 * Spawn a Claude Code agent via `ao spawn` for the given role and issue.
 * Cleans stale worktrees before spawning. Retries on failure up to max_retries.
 */
export async function spawnAgent(
  db: Kysely<Database>,
  ctx: SpawnContext
): Promise<string> {
  const agentId = generateAgentId();

  log.info(`Spawning ${ctx.role} agent for issue #${ctx.issueNumber}`, {
    agentId,
    role: ctx.role,
    workflow: ctx.workflowId,
  });

  // Clean stale worktrees that would block ao spawn
  cleanStaleWorktree(ctx.issueNumber);

  await createAgentSession(db, {
    id: agentId,
    workflow_id: ctx.workflowId,
    role: ctx.role,
    worktree_path: null,
    pr_number: null,
  });

  try {
    const proc = Bun.spawn(
      ["ao", "spawn", String(ctx.issueNumber)],
      {
        env: {
          ...process.env,
          ZAPBOT_AGENT_ID: agentId,
          ZAPBOT_AGENT_ROLE: ctx.role,
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    // Handle spawn result asynchronously (agent runs independently)
    proc.exited.then(async (code) => {
      if (code === 0) {
        log.info(`Agent ${agentId} spawn process exited successfully`, { agentId });
        return;
      }

      log.error(`Agent ${agentId} spawn process exited with code ${code}`, { agentId });

      // Check if we can retry
      const session = await getAgentSession(db, agentId);
      if (session && session.retry_count < session.max_retries) {
        await incrementRetryCount(db, agentId);
        log.warn(`Agent ${agentId} failed, retrying (${session.retry_count + 1}/${session.max_retries})`, {
          agentId,
          retry: session.retry_count + 1,
          maxRetries: session.max_retries,
        });
        // Clean worktree and re-spawn after a short delay
        cleanStaleWorktree(ctx.issueNumber);
        setTimeout(() => {
          spawnAgent(db, ctx).catch((err) => {
            log.error(`Retry spawn failed for ${agentId}: ${err}`, { agentId });
          });
        }, 5000);
      } else {
        // All retries exhausted
        await updateAgentStatus(db, agentId, "failed");
        if (_onAgentFailed) {
          await _onAgentFailed(db, agentId);
        }
      }
    }).catch(async (err) => {
      log.error(`Agent ${agentId} spawn error: ${err}`, { agentId });
      await updateAgentStatus(db, agentId, "failed");
      if (_onAgentFailed) {
        await _onAgentFailed(db, agentId);
      }
    });

    await updateAgentStatus(db, agentId, "running");
    log.info(`Agent ${agentId} spawned successfully`, { agentId, role: ctx.role });
  } catch (err) {
    log.error(`Failed to spawn agent ${agentId}: ${err}`, { agentId, role: ctx.role });
    await updateAgentStatus(db, agentId, "failed");
    if (_onAgentFailed) {
      await _onAgentFailed(db, agentId);
    }
  }

  return agentId;
}
