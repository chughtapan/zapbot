import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Kysely } from "kysely";
import { initDatabase, type Database } from "../src/store/database.js";
import {
  upsertWorkflow,
  createAgentSession,
  updateAgentStatus,
  updateProgressCommentId,
  updateAgentSessionFields,
  getActiveWorkflowsWithAgents,
  getWorkflow,
  getAgentSession,
} from "../src/store/queries.js";
import {
  readAgentTasks,
  formatProgressComment,
  formatFinalComment,
  type AgentTask,
} from "../src/agents/progress.js";
import { toClaudeProjectPath } from "../src/agents/spawner.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

let db: Kysely<Database>;
let dbPath: string;

beforeEach(async () => {
  dbPath = path.join(
    os.tmpdir(),
    `zapbot-progress-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  db = await initDatabase(dbPath);
});

afterEach(async () => {
  await db.destroy();
  try { fs.unlinkSync(dbPath); } catch {}
  try { fs.unlinkSync(dbPath + "-wal"); } catch {}
  try { fs.unlinkSync(dbPath + "-shm"); } catch {}
});

// ── Helpers ──────────────────────────────────────────────────────

async function createWorkflow(id: string, issueNumber: number, state: string): Promise<void> {
  await upsertWorkflow(db, {
    id,
    issue_number: issueNumber,
    repo: "owner/repo",
    state,
    level: "sub",
    parent_workflow_id: null,
    author: "tester",
    intent: "test",
  });
}

async function createAgent(
  id: string,
  workflowId: string,
  status = "running",
  sessionId: string | null = null
): Promise<void> {
  await createAgentSession(db, {
    id,
    workflow_id: workflowId,
    role: "implementer",
    worktree_path: null,
    pr_number: null,
    claude_session_id: sessionId,
  });
  if (status !== "spawning") {
    await db
      .updateTable("agent_sessions")
      .set({ status })
      .where("id", "=", id)
      .execute();
  }
}

function makeTempTaskDir(sessionUUID: string): string {
  const dir = path.join(os.tmpdir(), `claude-tasks-test-${Date.now()}`, sessionUUID);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Task file reading ────────────────────────────────────────────

describe("readAgentTasks", () => {
  it("returns empty array for nonexistent directory", async () => {
    const tasks = await readAgentTasks("nonexistent-uuid-12345");
    expect(tasks).toEqual([]);
  });

  it("reads valid task files sorted by ID", async () => {
    const uuid = `test-session-${Date.now()}`;
    const taskDir = path.join(os.homedir(), ".claude", "tasks", uuid);
    fs.mkdirSync(taskDir, { recursive: true });

    try {
      fs.writeFileSync(path.join(taskDir, "2.json"), JSON.stringify({
        id: "2",
        subject: "Create PR",
        activeForm: "Creating PR",
        status: "pending",
        blocks: [],
        blockedBy: ["1"],
      }));
      fs.writeFileSync(path.join(taskDir, "1.json"), JSON.stringify({
        id: "1",
        subject: "Write tests",
        activeForm: "Writing tests",
        status: "completed",
        blocks: ["2"],
        blockedBy: [],
      }));

      const tasks = await readAgentTasks(uuid);
      expect(tasks).toHaveLength(2);
      expect(tasks[0].id).toBe("1");
      expect(tasks[0].status).toBe("completed");
      expect(tasks[1].id).toBe("2");
      expect(tasks[1].status).toBe("pending");
    } finally {
      fs.rmSync(taskDir, { recursive: true, force: true });
    }
  });

  it("skips corrupt files gracefully", async () => {
    const uuid = `test-corrupt-${Date.now()}`;
    const taskDir = path.join(os.homedir(), ".claude", "tasks", uuid);
    fs.mkdirSync(taskDir, { recursive: true });

    try {
      fs.writeFileSync(path.join(taskDir, "1.json"), JSON.stringify({
        id: "1", subject: "Valid task", activeForm: "", status: "in_progress", blocks: [], blockedBy: [],
      }));
      fs.writeFileSync(path.join(taskDir, "2.json"), "not json at all");
      fs.writeFileSync(path.join(taskDir, "3.json"), JSON.stringify({ missing: "fields" }));

      const tasks = await readAgentTasks(uuid);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe("1");
    } finally {
      fs.rmSync(taskDir, { recursive: true, force: true });
    }
  });

  it("ignores non-numeric filenames", async () => {
    const uuid = `test-ignore-${Date.now()}`;
    const taskDir = path.join(os.homedir(), ".claude", "tasks", uuid);
    fs.mkdirSync(taskDir, { recursive: true });

    try {
      fs.writeFileSync(path.join(taskDir, "1.json"), JSON.stringify({
        id: "1", subject: "Task", activeForm: "", status: "pending", blocks: [], blockedBy: [],
      }));
      fs.writeFileSync(path.join(taskDir, "metadata.json"), JSON.stringify({ version: 1 }));
      fs.writeFileSync(path.join(taskDir, "readme.txt"), "hello");

      const tasks = await readAgentTasks(uuid);
      expect(tasks).toHaveLength(1);
    } finally {
      fs.rmSync(taskDir, { recursive: true, force: true });
    }
  });
});

// ── Comment formatting ───────────────────────────────────────────

describe("formatProgressComment", () => {
  it("formats a comment with tasks", () => {
    const tasks: AgentTask[] = [
      { id: "1", subject: "Analyze codebase", activeForm: "", status: "completed", blocks: [], blockedBy: [] },
      { id: "2", subject: "Create sub-issues", activeForm: "", status: "in_progress", blocks: [], blockedBy: [] },
      { id: "3", subject: "Post summary", activeForm: "", status: "pending", blocks: [], blockedBy: [] },
    ];
    const comment = formatProgressComment("implementer", tasks);

    expect(comment).toContain("### 🤖 Agent Progress");
    expect(comment).toContain("| 1 | Analyze codebase | ✅ completed |");
    expect(comment).toContain("| 2 | Create sub-issues | ⏳ in_progress |");
    expect(comment).toContain("| 3 | Post summary | ⏸️ pending |");
    expect(comment).toContain("**Progress:** 1/3");
    expect(comment).toContain("**Role:** implementer");
    expect(comment).toContain("_Updated automatically by Zapbot._");
  });

  it("formats a comment with no tasks", () => {
    const comment = formatProgressComment("triage", []);
    expect(comment).toContain("Agent is working...");
    expect(comment).toContain("**Role:** triage");
  });

  it("escapes pipe characters in subjects", () => {
    const tasks: AgentTask[] = [
      { id: "1", subject: "Fix A | B issue", activeForm: "", status: "pending", blocks: [], blockedBy: [] },
    ];
    const comment = formatProgressComment("implementer", tasks);
    expect(comment).toContain("Fix A \\| B issue");
  });
});

describe("formatFinalComment", () => {
  it("includes outcome in the comment", () => {
    const tasks: AgentTask[] = [
      { id: "1", subject: "Task", activeForm: "", status: "completed", blocks: [], blockedBy: [] },
    ];
    const comment = formatFinalComment("implementer", tasks, "Workflow complete");
    expect(comment).toContain("**Outcome:** Workflow complete");
    expect(comment).toContain("_Updated automatically by Zapbot._");
  });
});

// ── toClaudeProjectPath encoding ─────────────────────────────────

describe("toClaudeProjectPath", () => {
  it("encodes a Unix path correctly", () => {
    expect(toClaudeProjectPath("/home/user/.worktrees/zapbot/zap-1")).toBe(
      "home-user--worktrees-zapbot-zap-1"
    );
  });

  it("handles paths with dots", () => {
    expect(toClaudeProjectPath("/home/user/my.project")).toBe(
      "home-user-my-project"
    );
  });

  it("strips leading slash", () => {
    const result = toClaudeProjectPath("/foo/bar");
    expect(result).not.toMatch(/^\//);
    expect(result).toBe("foo-bar");
  });
});

// ── Query helpers ────────────────────────────────────────────────

describe("progress queries", () => {
  it("updateProgressCommentId stores the comment ID", async () => {
    await createWorkflow("wf-10", 10, "IMPLEMENTING");
    await updateProgressCommentId(db, "wf-10", 42);

    const wf = await getWorkflow(db, "wf-10");
    expect(wf!.progress_comment_id).toBe(42);
  });

  it("updateAgentSessionFields stores worktree_path and claude_session_id", async () => {
    await createWorkflow("wf-11", 11, "IMPLEMENTING");
    await createAgent("agent-11", "wf-11", "running");

    await updateAgentSessionFields(db, "agent-11", {
      worktree_path: "/tmp/wt/zap-1",
      claude_session_id: "uuid-abc-123",
    });

    const session = await getAgentSession(db, "agent-11");
    expect(session!.worktree_path).toBe("/tmp/wt/zap-1");
    expect(session!.claude_session_id).toBe("uuid-abc-123");
  });

  it("getActiveWorkflowsWithAgents returns active workflows with running agents", async () => {
    await createWorkflow("wf-active", 20, "IMPLEMENTING");
    await createAgent("agent-active", "wf-active", "running", "session-uuid");

    await createWorkflow("wf-done", 21, "DONE");
    await createAgent("agent-done", "wf-done", "completed");

    await createWorkflow("wf-noagent", 22, "IMPLEMENTING");
    await createAgent("agent-failed", "wf-noagent", "failed");

    const active = await getActiveWorkflowsWithAgents(db, ["DONE", "ABANDONED", "COMPLETED"]);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe("wf-active");
    expect(active[0].agent_role).toBe("implementer");
    expect(active[0].claude_session_id).toBe("session-uuid");
  });

  it("getActiveWorkflowsWithAgents includes spawning agents", async () => {
    await createWorkflow("wf-spawn", 30, "TRIAGE");
    await createAgentSession(db, {
      id: "agent-spawn",
      workflow_id: "wf-spawn",
      role: "triage",
      worktree_path: null,
      pr_number: null,
    });
    // Agent is in default "spawning" status

    const active = await getActiveWorkflowsWithAgents(db, ["DONE", "ABANDONED", "COMPLETED"]);
    expect(active).toHaveLength(1);
    expect(active[0].agent_id).toBe("agent-spawn");
  });

  it("migration 005 creates the new columns", async () => {
    // Verify the columns exist by inserting and reading
    await createWorkflow("wf-mig", 40, "PLANNING");
    const wf = await getWorkflow(db, "wf-mig");
    expect(wf!.progress_comment_id).toBeNull();

    await createAgent("agent-mig", "wf-mig", "running");
    const session = await getAgentSession(db, "agent-mig");
    expect(session!.claude_session_id).toBeNull();
  });
});
