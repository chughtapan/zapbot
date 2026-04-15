import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Kysely } from "kysely";
import { initDatabase, type Database } from "../src/store/database.js";
import {
  upsertWorkflow,
  createAgentSession,
  getAgentSession,
  getSessionsForCleanup,
  markSessionCleaned,
  updateWorkflowState,
} from "../src/store/queries.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

let db: Kysely<Database>;
let dbPath: string;

beforeEach(async () => {
  dbPath = path.join(
    os.tmpdir(),
    `zapbot-cleanup-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  db = await initDatabase(dbPath);
});

afterEach(async () => {
  await db.destroy();
  try { fs.unlinkSync(dbPath); } catch {}
  try { fs.unlinkSync(dbPath + "-wal"); } catch {}
  try { fs.unlinkSync(dbPath + "-shm"); } catch {}
});

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

async function createAgent(id: string, workflowId: string, status = "running"): Promise<void> {
  await createAgentSession(db, {
    id,
    workflow_id: workflowId,
    role: "implementer",
    worktree_path: null,
    pr_number: null,
  });
  if (status !== "spawning") {
    await db
      .updateTable("agent_sessions")
      .set({ status })
      .where("id", "=", id)
      .execute();
  }
}

describe("cleanup queries", () => {
  it("getSessionsForCleanup returns sessions in terminal workflow states", async () => {
    await createWorkflow("wf-done", 1, "DONE");
    await createAgent("agent-done-1", "wf-done", "completed");

    await createWorkflow("wf-active", 2, "IMPLEMENTING");
    await createAgent("agent-active-1", "wf-active", "running");

    const stale = await getSessionsForCleanup(db, ["DONE", "ABANDONED", "COMPLETED"]);
    expect(stale).toHaveLength(1);
    expect(stale[0].id).toBe("agent-done-1");
  });

  it("getSessionsForCleanup excludes already-cleaned sessions", async () => {
    await createWorkflow("wf-done", 1, "DONE");
    await createAgent("agent-cleaned", "wf-done", "completed");
    await markSessionCleaned(db, "agent-cleaned");

    const stale = await getSessionsForCleanup(db, ["DONE", "ABANDONED", "COMPLETED"]);
    expect(stale).toHaveLength(0);
  });

  it("markSessionCleaned sets cleaned_up_at timestamp", async () => {
    await createWorkflow("wf-done", 1, "DONE");
    await createAgent("agent-mark", "wf-done", "completed");

    const before = await getAgentSession(db, "agent-mark");
    expect(before!.cleaned_up_at).toBeNull();

    await markSessionCleaned(db, "agent-mark");

    const after = await getAgentSession(db, "agent-mark");
    expect(after!.cleaned_up_at).not.toBeNull();
    expect(after!.cleaned_up_at).toBeGreaterThan(0);
  });

  it("markSessionCleaned is idempotent", async () => {
    await createWorkflow("wf-done", 1, "DONE");
    await createAgent("agent-idem", "wf-done", "completed");

    await markSessionCleaned(db, "agent-idem");
    const first = await getAgentSession(db, "agent-idem");

    await markSessionCleaned(db, "agent-idem");
    const second = await getAgentSession(db, "agent-idem");

    // Both calls set a timestamp; the second just overwrites with a new one
    expect(first!.cleaned_up_at).not.toBeNull();
    expect(second!.cleaned_up_at).not.toBeNull();
  });

  it("getSessionsForCleanup handles ABANDONED state", async () => {
    await createWorkflow("wf-abandon", 3, "ABANDONED");
    await createAgent("agent-abandon", "wf-abandon", "failed");

    const stale = await getSessionsForCleanup(db, ["DONE", "ABANDONED", "COMPLETED"]);
    expect(stale).toHaveLength(1);
    expect(stale[0].id).toBe("agent-abandon");
  });

  it("getSessionsForCleanup handles COMPLETED parent state", async () => {
    await upsertWorkflow(db, {
      id: "wf-parent",
      issue_number: 10,
      repo: "owner/repo",
      state: "COMPLETED",
      level: "parent",
      parent_workflow_id: null,
      author: "tester",
      intent: "parent",
    });
    await createAgent("agent-parent", "wf-parent", "timeout");

    const stale = await getSessionsForCleanup(db, ["DONE", "ABANDONED", "COMPLETED"]);
    expect(stale).toHaveLength(1);
    expect(stale[0].id).toBe("agent-parent");
  });

  it("getSessionsForCleanup returns multiple sessions for one workflow", async () => {
    await createWorkflow("wf-multi", 5, "DONE");
    await createAgent("agent-impl", "wf-multi", "completed");
    await createAgent("agent-qe", "wf-multi", "completed");

    const stale = await getSessionsForCleanup(db, ["DONE", "ABANDONED", "COMPLETED"]);
    expect(stale).toHaveLength(2);
    const ids = stale.map((s) => s.id).sort();
    expect(ids).toEqual(["agent-impl", "agent-qe"]);
  });

  it("non-terminal workflows are never returned", async () => {
    const nonTerminal = ["PLANNING", "REVIEW", "IMPLEMENTING", "DRAFT_REVIEW", "VERIFYING", "TRIAGE", "TRIAGED"];
    for (let i = 0; i < nonTerminal.length; i++) {
      await createWorkflow(`wf-nt-${i}`, 100 + i, nonTerminal[i]);
      await createAgent(`agent-nt-${i}`, `wf-nt-${i}`, "running");
    }

    const stale = await getSessionsForCleanup(db, ["DONE", "ABANDONED", "COMPLETED"]);
    expect(stale).toHaveLength(0);
  });
});
