import { Kysely } from "kysely";
import type { Database } from "../store/database.js";
import { createAgentSession, updateAgentStatus, getAgentSession, incrementRetryCount } from "../store/queries.js";
import { createLogger } from "../logger.js";

const log = createLogger("agents");

export type AgentRole = "triage" | "planner" | "implementer" | "qe";

export type AgentFailureHandler = (db: Kysely<Database>, agentId: string) => Promise<void>;

export interface SpawnContext {
  issueNumber: number;
  repo: string;
  role: AgentRole;
  workflowId: string;
}

interface SpawnOptions {
  onFailed?: AgentFailureHandler;
  existingAgentId?: string;
}

// Track pending retry timers so we can cancel them on shutdown
const pendingTimers = new Set<Timer>();

export function cancelPendingRetries(): void {
  for (const t of pendingTimers) clearTimeout(t);
  pendingTimers.clear();
}

function generateAgentId(): string {
  return `agent-${crypto.randomUUID()}`;
}

async function cleanStaleWorktree(issueNumber: number): Promise<void> {
  const branch = `feat/issue-${issueNumber}`;
  try {
    const proc = Bun.spawn(["git", "worktree", "list", "--porcelain"], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    if (!stdout.includes(`refs/heads/${branch}`)) return;

    // Porcelain output is block-structured, separated by blank lines
    for (const block of stdout.split("\n\n")) {
      if (!block.includes(`refs/heads/${branch}`)) continue;
      const wtLine = block.split("\n").find((l) => l.startsWith("worktree "));
      if (!wtLine) continue;
      const wtPath = wtLine.slice("worktree ".length);
      log.warn(`Removing stale worktree at ${wtPath}`, { issueNumber, branch });
      const rm = Bun.spawn(["git", "worktree", "remove", "--force", wtPath], { stdout: "pipe", stderr: "pipe" });
      await rm.exited;
      log.info(`Removed stale worktree at ${wtPath}`, { branch });
    }
  } catch (err) {
    log.warn(`Failed to clean stale worktree for ${branch}: ${err}`, { issueNumber });
  }
}

/**
 * Spawn a Claude Code agent via `ao spawn` for the given role and issue.
 * Cleans stale worktrees before spawning. Retries on failure up to max_retries,
 * reusing the same agent session to avoid orphaned rows.
 */
export async function spawnAgent(
  db: Kysely<Database>,
  ctx: SpawnContext,
  opts: SpawnOptions = {}
): Promise<string> {
  const agentId = opts.existingAgentId ?? generateAgentId();
  const isRetry = !!opts.existingAgentId;

  log.info(`${isRetry ? "Retrying" : "Spawning"} ${ctx.role} agent for issue #${ctx.issueNumber}`, {
    agentId,
    role: ctx.role,
    workflow: ctx.workflowId,
    isRetry,
  });

  await cleanStaleWorktree(ctx.issueNumber);

  if (!isRetry) {
    await createAgentSession(db, {
      id: agentId,
      workflow_id: ctx.workflowId,
      role: ctx.role,
      worktree_path: null,
      pr_number: null,
    });
  } else {
    await updateAgentStatus(db, agentId, "spawning");
  }

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

    proc.exited.then(async (code) => {
      if (code === 0) {
        log.info(`Agent ${agentId} spawn process exited successfully`, { agentId });
        return;
      }

      log.error(`Agent ${agentId} spawn process exited with code ${code}`, { agentId });

      const session = await getAgentSession(db, agentId);
      if (session && session.retry_count < session.max_retries) {
        await incrementRetryCount(db, agentId);
        log.warn(`Agent ${agentId} failed, retrying (${session.retry_count + 1}/${session.max_retries})`, {
          agentId,
          retry: session.retry_count + 1,
          maxRetries: session.max_retries,
        });
        const timer = setTimeout(() => {
          pendingTimers.delete(timer);
          spawnAgent(db, ctx, { ...opts, existingAgentId: agentId }).catch((err) => {
            log.error(`Retry spawn failed for ${agentId}: ${err}`, { agentId });
          });
        }, 5000);
        pendingTimers.add(timer);
      } else {
        await updateAgentStatus(db, agentId, "failed");
        if (opts.onFailed) await opts.onFailed(db, agentId);
      }
    }).catch(async (err) => {
      log.error(`Agent ${agentId} spawn error: ${err}`, { agentId });
      await updateAgentStatus(db, agentId, "failed");
      if (opts.onFailed) await opts.onFailed(db, agentId);
    });

    await updateAgentStatus(db, agentId, "running");
    log.info(`Agent ${agentId} spawned successfully`, { agentId, role: ctx.role });
  } catch (err) {
    log.error(`Failed to spawn agent ${agentId}: ${err}`, { agentId, role: ctx.role });
    await updateAgentStatus(db, agentId, "failed");
    if (opts.onFailed) await opts.onFailed(db, agentId);
  }

  return agentId;
}
