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
  sortTasksByStatus,
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
  it("formats a task list with checkboxes", () => {
    const tasks: AgentTask[] = [
      { id: "1", subject: "Analyze codebase", activeForm: "", status: "completed", blocks: [], blockedBy: [] },
      { id: "2", subject: "Create sub-issues", activeForm: "", status: "in_progress", blocks: [], blockedBy: [] },
      { id: "3", subject: "Post summary", activeForm: "", status: "pending", blocks: [], blockedBy: [] },
    ];
    const comment = formatProgressComment("implementer", tasks);

    expect(comment).toContain("- [x] Analyze codebase");
    expect(comment).toContain("- [ ] Create sub-issues ← working");
    expect(comment).toContain("- [ ] Post summary");
    expect(comment).not.toContain("Post summary ← working");
    expect(comment).toContain("1/3 done");
    expect(comment).toContain("**implementer** agent progress");
  });

  it("formats a comment with no tasks", () => {
    const comment = formatProgressComment("triage", []);
    expect(comment).toContain("Agent is working...");
    expect(comment).toContain("**triage** agent progress");
  });
});

describe("sortTasksByStatus", () => {
  it("sorts completed first, then in_progress, then pending", () => {
    const tasks: AgentTask[] = [
      { id: "1", subject: "Run tests", activeForm: "", status: "pending", blocks: [], blockedBy: [] },
      { id: "2", subject: "Update handler.ts", activeForm: "", status: "completed", blocks: [], blockedBy: [] },
      { id: "3", subject: "Update endpoints.test.ts", activeForm: "", status: "in_progress", blocks: [], blockedBy: [] },
      { id: "4", subject: "Rewrite auth.test.ts", activeForm: "", status: "completed", blocks: [], blockedBy: [] },
      { id: "5", subject: "Update index.ts", activeForm: "", status: "completed", blocks: [], blockedBy: [] },
      { id: "6", subject: "Remove jose", activeForm: "", status: "pending", blocks: [], blockedBy: [] },
      { id: "7", subject: "Rewrite auth.ts", activeForm: "", status: "completed", blocks: [], blockedBy: [] },
    ];
    const sorted = sortTasksByStatus(tasks);
    expect(sorted.map((t) => t.status)).toEqual([
      "completed", "completed", "completed", "completed",
      "in_progress",
      "pending", "pending",
    ]);
    // Preserve creation order within each group
    expect(sorted.filter((t) => t.status === "completed").map((t) => t.id)).toEqual(["2", "4", "5", "7"]);
    expect(sorted.filter((t) => t.status === "pending").map((t) => t.id)).toEqual(["1", "6"]);
  });

  it("preserves order when already sorted", () => {
    const tasks: AgentTask[] = [
      { id: "1", subject: "A", activeForm: "", status: "completed", blocks: [], blockedBy: [] },
      { id: "2", subject: "B", activeForm: "", status: "in_progress", blocks: [], blockedBy: [] },
      { id: "3", subject: "C", activeForm: "", status: "pending", blocks: [], blockedBy: [] },
    ];
    const sorted = sortTasksByStatus(tasks);
    expect(sorted.map((t) => t.id)).toEqual(["1", "2", "3"]);
  });

  it("does not mutate the original array", () => {
    const tasks: AgentTask[] = [
      { id: "1", subject: "A", activeForm: "", status: "pending", blocks: [], blockedBy: [] },
      { id: "2", subject: "B", activeForm: "", status: "completed", blocks: [], blockedBy: [] },
    ];
    sortTasksByStatus(tasks);
    expect(tasks[0].id).toBe("1");
    expect(tasks[1].id).toBe("2");
  });
});

describe("formatProgressComment with out-of-order tasks", () => {
  it("renders completed tasks first in the progress comment", () => {
    const tasks: AgentTask[] = [
      { id: "1", subject: "Run tests", activeForm: "", status: "pending", blocks: [], blockedBy: [] },
      { id: "2", subject: "Update handler.ts", activeForm: "", status: "completed", blocks: [], blockedBy: [] },
      { id: "3", subject: "Update endpoints.test.ts", activeForm: "", status: "in_progress", blocks: [], blockedBy: [] },
      { id: "4", subject: "Rewrite auth.ts", activeForm: "", status: "completed", blocks: [], blockedBy: [] },
    ];
    const comment = formatProgressComment("implementer", tasks);
    const lines = comment.split("\n").filter((l) => l.startsWith("- ["));

    // Completed first, then in_progress, then pending
    expect(lines[0]).toBe("- [x] Update handler.ts");
    expect(lines[1]).toBe("- [x] Rewrite auth.ts");
    expect(lines[2]).toBe("- [ ] Update endpoints.test.ts ← working");
    expect(lines[3]).toBe("- [ ] Run tests");
    expect(comment).toContain("2/4 done");
  });
});

describe("formatFinalComment", () => {
  it("includes outcome in the comment", () => {
    const tasks: AgentTask[] = [
      { id: "1", subject: "Task", activeForm: "", status: "completed", blocks: [], blockedBy: [] },
    ];
    const comment = formatFinalComment("implementer", tasks, "Workflow complete");
    expect(comment).toContain("**Workflow complete**");
    expect(comment).toContain("- [x] Task");
  });
});

// ── toClaudeProjectPath encoding ─────────────────────────────────

describe("toClaudeProjectPath", () => {
  it("encodes a Unix path correctly", () => {
    expect(toClaudeProjectPath("/home/user/.worktrees/zapbot/zap-1")).toBe(
      "-home-user--worktrees-zapbot-zap-1"
    );
  });

  it("handles paths with dots", () => {
    expect(toClaudeProjectPath("/home/user/my.project")).toBe(
      "-home-user-my-project"
    );
  });

  it("replaces leading slash with dash (matching Claude Code encoding)", () => {
    const result = toClaudeProjectPath("/foo/bar");
    expect(result).toBe("-foo-bar");
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
