import { Kysely } from "kysely";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { Database } from "../store/database.js";
import { createAgentSession, updateAgentStatus, getAgentSession, incrementRetryCount, updateAgentSessionFields } from "../store/queries.js";
import { createLogger } from "../logger.js";
import { findSessionForIssue } from "./session-lookup.js";
import { getInstallationToken } from "../github/client.js";

const ZAPBOT_DIR = path.resolve(import.meta.dir, "../..");

const log = createLogger("agents");

export type AgentRole = "triage" | "planner" | "implementer" | "qe" | "investigator";

export type AgentFailureHandler = (db: Kysely<Database>, agentId: string) => Promise<void>;

export interface SpawnContext {
  issueNumber: number;
  repo: string;
  role: AgentRole;
  workflowId: string;
  projectName?: string;
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

/**
 * Resolve the worktree path for a given issue by parsing `ao session ls` porcelain output
 * or `git worktree list` for the branch pattern.
 */
async function resolveWorktreePath(issueNumber: number): Promise<string | null> {
  const branch = `feat/issue-${issueNumber}`;
  try {
    const proc = Bun.spawn(["git", "worktree", "list", "--porcelain"], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    for (const block of stdout.split("\n\n")) {
      if (!block.includes(`refs/heads/${branch}`)) continue;
      const wtLine = block.split("\n").find((l) => l.startsWith("worktree "));
      if (wtLine) return wtLine.slice("worktree ".length);
    }
  } catch (err) {
    log.warn(`Failed to resolve worktree path for issue #${issueNumber}: ${err}`);
  }
  return null;
}

/**
 * Encode a worktree path the same way Claude Code does for its project directory.
 * Strips leading /, replaces / and . with -.
 */
export function toClaudeProjectPath(worktreePath: string): string {
  return worktreePath
    .replace(/\\/g, "/")
    .replace(/:/g, "")
    .replace(/[/.]/g, "-");
}

/**
 * Given a worktree path, find the Claude Code session UUID by locating the
 * latest .jsonl file in the Claude project directory.
 */
async function resolveClaudeSessionId(worktreePath: string): Promise<string | null> {
  const encoded = toClaudeProjectPath(worktreePath);
  const projectDir = path.join(os.homedir(), ".claude", "projects", encoded);

  try {
    const entries = await fs.promises.readdir(projectDir, { withFileTypes: true });
    const jsonlFiles = await Promise.all(
      entries
        .filter((e) => e.isFile() && e.name.endsWith(".jsonl") && !e.name.startsWith("agent-"))
        .map(async (e) => {
          const stat = await fs.promises.stat(path.join(projectDir, e.name));
          return { name: e.name, mtimeMs: stat.mtimeMs };
        })
    );
    jsonlFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (jsonlFiles.length === 0) return null;
    return jsonlFiles[0].name.replace(".jsonl", "");
  } catch {
    return null;
  }
}

function buildPrompt(ctx: SpawnContext): string {
  return `You are a ${ctx.role} agent. Read GitHub issue #${ctx.issueNumber} in repo ${ctx.repo} and follow the instructions in .agent-rules.md. Start working now.`;
}

function generateAgentId(): string {
  return `agent-${crypto.randomUUID()}`;
}

// If an ao session for this issue reports a non-terminal status, its worktree
// is still the legitimate home of in-progress work — the recovery path is
// `ao session restore`, not `git worktree remove --force`. See
// safer-by-default#65 (tier-1 reentrance spike).
const RESTORABLE_AO_STATUSES = new Set(["active", "ready", "stuck", "terminated", "idle"]);

async function hasRestorableAoSession(issueNumber: number): Promise<boolean> {
  try {
    const proc = Bun.spawn(["ao", "session", "ls", "--json"], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return false;
    const sessions = JSON.parse(stdout) as Array<{ issueId?: number | string | null; status?: string }>;
    for (const s of sessions) {
      if (s?.issueId == null) continue;
      const sid = typeof s.issueId === "string" ? Number(s.issueId) : s.issueId;
      if (sid !== issueNumber) continue;
      if (s.status && RESTORABLE_AO_STATUSES.has(s.status)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function cleanStaleWorktree(issueNumber: number): Promise<void> {
  const branch = `feat/issue-${issueNumber}`;
  try {
    const proc = Bun.spawn(["git", "worktree", "list", "--porcelain"], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    if (!stdout.includes(`refs/heads/${branch}`)) return;

    if (await hasRestorableAoSession(issueNumber)) {
      log.warn(
        `Skipping cleanStaleWorktree for ${branch}: restorable ao session present. ` +
        `Use 'ao session restore' to resume; see safer-by-default#65.`,
        { issueNumber, branch },
      );
      return;
    }

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

  // Copy role-specific agent rules so AO gives the agent the right instructions.
  //
  // RACE CONDITION NOTE: This writes to a shared path (.agent-rules.md) in the
  // project root. If two agents for different roles spawn concurrently, the second
  // write stomps the first agent's rules file. This is mitigated by the fact that
  // AO copies project files into each agent's worktree at spawn time, so the agent
  // gets a snapshot of .agent-rules.md as it existed when `ao spawn` ran. The race
  // window is limited to the gap between copyFileSync and AO reading the file during
  // spawn (typically < 1 second). A lock or per-agent filename would eliminate this
  // entirely, but AO expects `.agent-rules.md` specifically, so this is acceptable
  // given the narrow window.
  const rulesFile = path.join(ZAPBOT_DIR, `templates/agent-rules-${ctx.role}.md`);
  const projectRules = path.join(process.cwd(), ".agent-rules.md");
  if (fs.existsSync(rulesFile)) {
    fs.copyFileSync(rulesFile, projectRules);
    log.info(`Wrote ${ctx.role} agent rules to ${projectRules}`, { role: ctx.role });
  }

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
    const spawnArgs = ["ao", "spawn", String(ctx.issueNumber)];

    // Build env for ao spawn: it needs AO_CONFIG_PATH to find the yaml,
    // and AO_PROJECT_ID to select the right project in multi-repo setups.
    // GH_TOKEN makes gh CLI and git operations run as the bot, not the user.
    const spawnEnv: Record<string, string | undefined> = {
      ...process.env,
      ZAPBOT_AGENT_ID: agentId,
      ZAPBOT_AGENT_ROLE: ctx.role,
    };
    const botToken = await getInstallationToken();
    if (botToken) {
      spawnEnv.GH_TOKEN = botToken;
    }
    if (process.env.ZAPBOT_CONFIG) {
      spawnEnv.AO_CONFIG_PATH = process.env.ZAPBOT_CONFIG;
    }
    if (ctx.projectName) {
      spawnEnv.AO_PROJECT_ID = ctx.projectName;
    }

    const proc = Bun.spawn(
      spawnArgs,
      {
        env: spawnEnv,
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    proc.exited.then(async (code) => {
      if (code === 0) {
        await updateAgentStatus(db, agentId, "running");
        log.info(`Agent ${agentId} spawn process exited successfully`, { agentId });

        // Resolve and store worktree path + Claude session UUID for progress tracking
        const worktreePath = await resolveWorktreePath(ctx.issueNumber);
        if (worktreePath) {
          const fields: { worktree_path: string; claude_session_id?: string } = { worktree_path: worktreePath };
          const sessionUUID = await resolveClaudeSessionId(worktreePath);
          if (sessionUUID) {
            fields.claude_session_id = sessionUUID;
            log.info(`Resolved Claude session ${sessionUUID} for agent ${agentId}`, { agentId, worktreePath });
          }
          await updateAgentSessionFields(db, agentId, fields);
        }

        // Re-deliver prompt after a delay to work around AO prompt delivery race.
        // AO pastes the prompt before Claude Code finishes loading, so it gets swallowed.
        const sessionName = await findSessionForIssue(ctx.issueNumber);
        if (sessionName) {
          const prompt = buildPrompt(ctx);
          const sendTimer = setTimeout(() => {
            pendingTimers.delete(sendTimer);
            (async () => {
              try {
                log.info(`Re-delivering prompt to ${sessionName}`, { agentId, session: sessionName });
                const send = Bun.spawn(["ao", "send", sessionName, prompt], { stdout: "pipe", stderr: "pipe" });
                const sendCode = await send.exited;
                if (sendCode !== 0) {
                  log.warn(`ao send to ${sessionName} failed (code ${sendCode})`, { agentId });
                }
              } catch (err) {
                log.error(`Prompt re-delivery failed for ${sessionName}: ${err}`, { agentId });
              }
            })();
          }, 15000); // 15s delay for Claude Code to finish loading
          pendingTimers.add(sendTimer);
        }
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

    // Status stays "spawning" until .exited handler confirms success or failure.
    // Don't set "running" prematurely — if spawn fails fast, DB would lie.
    log.info(`Agent ${agentId} spawned successfully`, { agentId, role: ctx.role });
  } catch (err) {
    log.error(`Failed to spawn agent ${agentId}: ${err}`, { agentId, role: ctx.role });
    await updateAgentStatus(db, agentId, "failed");
    if (opts.onFailed) await opts.onFailed(db, agentId);
  }

  return agentId;
}
