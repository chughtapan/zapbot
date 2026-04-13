import { Kysely } from "kysely";
import type { Database } from "../store/database.js";
import { createAgentSession, updateAgentStatus } from "../store/queries.js";
import { createLogger } from "../logger.js";

const log = createLogger("agents");

export type AgentRole = "triage" | "planner" | "implementer" | "qe";

export interface SpawnContext {
  issueNumber: number;
  repo: string;
  role: AgentRole;
  workflowId: string;
}

function generateAgentId(): string {
  return `agent-${crypto.randomUUID()}`;
}

/**
 * Spawn a Claude Code agent via `ao spawn` for the given role and issue.
 * Tracks the session in SQLite.
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

    // Don't await — the agent runs independently
    proc.exited.then(async (code) => {
      if (code === 0) {
        log.info(`Agent ${agentId} spawn process exited successfully`, { agentId });
      } else {
        log.error(`Agent ${agentId} spawn process exited with code ${code}`, { agentId });
        await updateAgentStatus(db, agentId, "failed");
      }
    }).catch((err) => {
      log.error(`Agent ${agentId} spawn error: ${err}`, { agentId });
    });

    await updateAgentStatus(db, agentId, "running");
    log.info(`Agent ${agentId} spawned successfully`, { agentId, role: ctx.role });
  } catch (err) {
    log.error(`Failed to spawn agent ${agentId}: ${err}`, { agentId, role: ctx.role });
    await updateAgentStatus(db, agentId, "failed");
  }

  return agentId;
}
