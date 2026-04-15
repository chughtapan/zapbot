import { Kysely } from "kysely";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { Database } from "../store/database.js";
import { getActiveWorkflowsWithAgents, updateProgressCommentId } from "../store/queries.js";
import { TERMINAL_STATES } from "../state-machine/states.js";
import { toClaudeProjectPath } from "./spawner.js";
import type { GitHubClient } from "../github/client.js";
import { createLogger } from "../logger.js";

const log = createLogger("progress");

// ── Task file types ─────────────────────────────────────────────

export interface AgentTask {
  id: string;
  subject: string;
  activeForm: string;
  status: "pending" | "in_progress" | "completed";
  blocks: string[];
  blockedBy: string[];
}

function isValidTask(obj: unknown): obj is AgentTask {
  if (typeof obj !== "object" || obj === null) return false;
  const t = obj as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    typeof t.subject === "string" &&
    typeof t.status === "string" &&
    ["pending", "in_progress", "completed"].includes(t.status as string)
  );
}

// ── Task file reading ───────────────────────────────────────────

/**
 * Given a Claude session UUID, read all task files from ~/.claude/tasks/{UUID}/.
 * Returns parsed tasks sorted by ID. Handles missing dirs and corrupt files.
 */
export async function readAgentTasks(sessionUUID: string): Promise<AgentTask[]> {
  const taskDir = path.join(os.homedir(), ".claude", "tasks", sessionUUID);

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(taskDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const taskFiles = entries
    .filter((e) => e.isFile() && /^\d+\.json$/.test(e.name))
    .sort((a, b) => parseInt(a.name) - parseInt(b.name));

  const tasks: AgentTask[] = [];
  for (const file of taskFiles) {
    try {
      const content = await fs.promises.readFile(path.join(taskDir, file.name), "utf-8");
      const parsed = JSON.parse(content);
      if (isValidTask(parsed)) {
        tasks.push({
          id: parsed.id,
          subject: parsed.subject,
          activeForm: parsed.activeForm || "",
          status: parsed.status,
          blocks: Array.isArray(parsed.blocks) ? parsed.blocks : [],
          blockedBy: Array.isArray(parsed.blockedBy) ? parsed.blockedBy : [],
        });
      } else {
        log.warn(`Invalid task file ${file.name} in session ${sessionUUID}`);
      }
    } catch (err) {
      log.warn(`Failed to read task file ${file.name} in session ${sessionUUID}: ${err}`);
    }
  }

  return tasks;
}

/**
 * Re-resolve the Claude session UUID from a worktree path.
 * Used as a fallback when the stored claude_session_id is stale.
 */
export async function resolveClaudeSessionFromWorktree(worktreePath: string): Promise<string | null> {
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

// ── Comment formatting ───────���──────────────────────────────────

const STATUS_ICON: Record<string, string> = {
  pending: "⏸️",
  in_progress: "⏳",
  completed: "✅",
};

export function formatProgressComment(role: string, tasks: AgentTask[]): string {
  const lines: string[] = ["### 🤖 Agent Progress", ""];

  if (tasks.length === 0) {
    lines.push(`**Role:** ${role} | Agent is working...`, "");
    lines.push("_Updated automatically by Zapbot._");
    return lines.join("\n");
  }

  lines.push("| # | Task | Status |");
  lines.push("|---|------|--------|");

  for (const task of tasks) {
    const icon = STATUS_ICON[task.status] || "❓";
    const subject = task.subject.replace(/\|/g, "\\|");
    lines.push(`| ${task.id} | ${subject} | ${icon} ${task.status} |`);
  }

  const completed = tasks.filter((t) => t.status === "completed").length;
  const now = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  lines.push("");
  lines.push(`**Role:** ${role} | **Progress:** ${completed}/${tasks.length} | **Updated:** ${now}`);
  lines.push("");
  lines.push("_Updated automatically by Zapbot._");

  return lines.join("\n");
}

export function formatFinalComment(role: string, tasks: AgentTask[], outcome: string): string {
  const base = formatProgressComment(role, tasks);
  return base.replace(
    "_Updated automatically by Zapbot._",
    `**Outcome:** ${outcome}\n\n_Updated automatically by Zapbot._`
  );
}

// ── Polling loop ───────��────────────────────────────────────────

/** In-memory cache of last-seen task state per workflow to avoid unnecessary API calls. */
const lastTaskHash = new Map<string, string>();

function hashTasks(tasks: AgentTask[]): string {
  return tasks.map((t) => `${t.id}:${t.status}`).join(",");
}

export function startProgressPoller(
  db: Kysely<Database>,
  gh: GitHubClient,
  intervalMs = 60_000
): { stop: () => void } {
  let running = true;

  async function poll(): Promise<void> {
    try {
      const terminalList = Array.from(TERMINAL_STATES);
      const activeWorkflows = await getActiveWorkflowsWithAgents(db, terminalList);

      for (const wf of activeWorkflows) {
        try {
          let sessionUUID = wf.claude_session_id;

          // If no stored UUID, try to resolve from worktree path
          if (!sessionUUID && wf.agent_id) {
            // Look up worktree_path from the agent session
            const agent = await db
              .selectFrom("agent_sessions")
              .select(["worktree_path"])
              .where("id", "=", wf.agent_id)
              .executeTakeFirst();
            if (agent?.worktree_path) {
              sessionUUID = await resolveClaudeSessionFromWorktree(agent.worktree_path);
            }
          }

          if (!sessionUUID) continue;

          const tasks = await readAgentTasks(sessionUUID);
          const hash = hashTasks(tasks);
          const prevHash = lastTaskHash.get(wf.id);

          if (hash === prevHash) continue;
          lastTaskHash.set(wf.id, hash);

          const body = formatProgressComment(wf.agent_role, tasks);

          if (wf.progress_comment_id) {
            await gh.updateComment(wf.repo, wf.progress_comment_id, body);
          } else {
            const result = await gh.postComment(wf.repo, wf.issue_number, body);
            await updateProgressCommentId(db, wf.id, result.id);
          }

          log.debug(`Updated progress for ${wf.id}`, { tasks: tasks.length });
        } catch (err) {
          log.warn(`Progress update failed for ${wf.id}: ${err}`);
        }
      }
    } catch (err) {
      log.error(`Progress poller error: ${err}`);
    }
  }

  const interval = setInterval(() => {
    if (running) poll();
  }, intervalMs);

  // Run first poll after a short delay to let agents start
  const initialDelay = setTimeout(() => {
    if (running) poll();
  }, 10_000);

  return {
    stop() {
      running = false;
      clearInterval(interval);
      clearTimeout(initialDelay);
      lastTaskHash.clear();
    },
  };
}
