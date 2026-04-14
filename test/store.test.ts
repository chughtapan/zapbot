import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Kysely } from "kysely";
import { initDatabase, type Database } from "../src/store/database.js";
import {
  getWorkflow,
  getWorkflowByIssue,
  upsertWorkflow,
  updateWorkflowState,
  getSubWorkflows,
  createAgentSession,
  getAgentSessions,
  getAgentSession,
  updateAgentHeartbeat,
  updateAgentStatus,
  getStaleAgents,
  addTransition,
  getTransitionHistory,
  hasDeliveryBeenProcessed,
  withTransaction,
  incrementRetryCount,
} from "../src/store/queries.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

let db: Kysely<Database>;
let dbPath: string;

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `zapbot-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = await initDatabase(dbPath);
});

afterEach(async () => {
  await db.destroy();
  try { fs.unlinkSync(dbPath); } catch {}
  try { fs.unlinkSync(dbPath + "-wal"); } catch {}
  try { fs.unlinkSync(dbPath + "-shm"); } catch {}
});

describe("migrations", () => {
  it("creates all tables", async () => {
    const tables = await db
      .selectFrom("sqlite_master" as any)
      .select(["name"])
      .where("type" as any, "=", "table")
      .execute();
    const names = tables.map((t: any) => t.name);
    expect(names).toContain("workflows");
    expect(names).toContain("agent_sessions");
    expect(names).toContain("transitions");
    expect(names).toContain("_migrations");
  });

  it("is idempotent", async () => {
    // Running init again should not throw
    const db2 = await initDatabase(dbPath);
    await db2.destroy();
  });
});

describe("workflows", () => {
  it("inserts and retrieves a workflow", async () => {
    await upsertWorkflow(db, {
      id: "wf-1",
      issue_number: 1,
      repo: "owner/repo",
      state: "TRIAGE",
      level: "parent",
      parent_workflow_id: null,
      author: "alice",
      intent: "build a thing",
    });

    const wf = await getWorkflow(db, "wf-1");
    expect(wf).toBeDefined();
    expect(wf!.state).toBe("TRIAGE");
    expect(wf!.level).toBe("parent");
    expect(wf!.author).toBe("alice");
    expect(wf!.draft_review_cycles).toBe(0);
  });

  it("upserts on conflict", async () => {
    await upsertWorkflow(db, {
      id: "wf-1",
      issue_number: 1,
      repo: "owner/repo",
      state: "TRIAGE",
      level: "parent",
      parent_workflow_id: null,
      author: "alice",
      intent: "v1",
    });
    await upsertWorkflow(db, {
      id: "wf-1",
      issue_number: 1,
      repo: "owner/repo",
      state: "TRIAGED",
      level: "parent",
      parent_workflow_id: null,
      author: "alice",
      intent: "v2",
    });

    const wf = await getWorkflow(db, "wf-1");
    expect(wf!.state).toBe("TRIAGED");
    expect(wf!.intent).toBe("v2");
  });

  it("retrieves by issue number", async () => {
    await upsertWorkflow(db, {
      id: "wf-42",
      issue_number: 42,
      repo: "owner/repo",
      state: "PLANNING",
      level: "sub",
      parent_workflow_id: null,
      author: "bob",
      intent: "fix bug",
    });

    const wf = await getWorkflowByIssue(db, 42, "owner/repo");
    expect(wf).toBeDefined();
    expect(wf!.id).toBe("wf-42");
  });

  it("updates workflow state", async () => {
    await upsertWorkflow(db, {
      id: "wf-1",
      issue_number: 1,
      repo: "r",
      state: "TRIAGE",
      level: "parent",
      parent_workflow_id: null,
      author: "a",
      intent: "",
    });

    await updateWorkflowState(db, "wf-1", "TRIAGED");
    const wf = await getWorkflow(db, "wf-1");
    expect(wf!.state).toBe("TRIAGED");
  });

  it("tracks draft_review_cycles", async () => {
    await upsertWorkflow(db, {
      id: "wf-1",
      issue_number: 1,
      repo: "r",
      state: "DRAFT_REVIEW",
      level: "sub",
      parent_workflow_id: null,
      author: "a",
      intent: "",
    });

    await updateWorkflowState(db, "wf-1", "VERIFYING", { draft_review_cycles: 1 });
    const wf = await getWorkflow(db, "wf-1");
    expect(wf!.draft_review_cycles).toBe(1);
  });

  it("retrieves sub-workflows", async () => {
    await upsertWorkflow(db, {
      id: "wf-10",
      issue_number: 10,
      repo: "r",
      state: "TRIAGED",
      level: "parent",
      parent_workflow_id: null,
      author: "a",
      intent: "",
    });
    await upsertWorkflow(db, {
      id: "wf-11",
      issue_number: 11,
      repo: "r",
      state: "PLANNING",
      level: "sub",
      parent_workflow_id: "wf-10",
      author: "a",
      intent: "task 1",
    });
    await upsertWorkflow(db, {
      id: "wf-12",
      issue_number: 12,
      repo: "r",
      state: "APPROVED",
      level: "sub",
      parent_workflow_id: "wf-10",
      author: "a",
      intent: "task 2",
    });

    const subs = await getSubWorkflows(db, "wf-10");
    expect(subs).toHaveLength(2);
  });
});

describe("agent sessions", () => {
  beforeEach(async () => {
    await upsertWorkflow(db, {
      id: "wf-1",
      issue_number: 1,
      repo: "r",
      state: "IMPLEMENTING",
      level: "sub",
      parent_workflow_id: null,
      author: "a",
      intent: "",
    });
  });

  it("creates and retrieves sessions", async () => {
    await createAgentSession(db, {
      id: "agent-abc",
      workflow_id: "wf-1",
      role: "implementer",
      worktree_path: "/tmp/wt",
      pr_number: null,
    });

    const sessions = await getAgentSessions(db, "wf-1");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].role).toBe("implementer");
    expect(sessions[0].status).toBe("spawning");
  });

  it("gets session by id", async () => {
    await createAgentSession(db, {
      id: "agent-xyz",
      workflow_id: "wf-1",
      role: "qe",
      worktree_path: null,
      pr_number: null,
    });

    const session = await getAgentSession(db, "agent-xyz");
    expect(session).toBeDefined();
    expect(session!.role).toBe("qe");
  });

  it("updates heartbeat", async () => {
    await createAgentSession(db, {
      id: "agent-hb",
      workflow_id: "wf-1",
      role: "implementer",
      worktree_path: null,
      pr_number: null,
    });

    const before = await getAgentSession(db, "agent-hb");
    // Small delay to ensure different timestamp
    await new Promise((r) => setTimeout(r, 50));
    await updateAgentHeartbeat(db, "agent-hb");
    const after = await getAgentSession(db, "agent-hb");
    expect(after!.last_heartbeat).toBeGreaterThanOrEqual(before!.last_heartbeat);
  });

  it("updates status with pr_number", async () => {
    await createAgentSession(db, {
      id: "agent-s",
      workflow_id: "wf-1",
      role: "implementer",
      worktree_path: null,
      pr_number: null,
    });

    await updateAgentStatus(db, "agent-s", "running", 42);
    const s = await getAgentSession(db, "agent-s");
    expect(s!.status).toBe("running");
    expect(s!.pr_number).toBe(42);

    await updateAgentStatus(db, "agent-s", "completed");
    const s2 = await getAgentSession(db, "agent-s");
    expect(s2!.status).toBe("completed");
    expect(s2!.completed_at).not.toBeNull();
  });

  it("finds stale agents", async () => {
    await createAgentSession(db, {
      id: "agent-stale",
      workflow_id: "wf-1",
      role: "implementer",
      worktree_path: null,
      pr_number: null,
    });

    // Manually set heartbeat to 20 minutes ago
    const oldTime = Math.floor(Date.now() / 1000) - 1200;
    await db
      .updateTable("agent_sessions")
      .set({ last_heartbeat: oldTime, status: "running" })
      .where("id", "=", "agent-stale")
      .execute();

    const stale = await getStaleAgents(db);
    expect(stale).toHaveLength(1);
    expect(stale[0].id).toBe("agent-stale");
  });
});

describe("transitions", () => {
  beforeEach(async () => {
    await upsertWorkflow(db, {
      id: "wf-1",
      issue_number: 1,
      repo: "r",
      state: "TRIAGE",
      level: "parent",
      parent_workflow_id: null,
      author: "a",
      intent: "",
    });
  });

  it("adds and retrieves transitions", async () => {
    await addTransition(db, {
      id: "t-1",
      workflow_id: "wf-1",
      from_state: "TRIAGE",
      to_state: "TRIAGED",
      event_type: "triage_complete",
      triggered_by: "agent-triage",
      metadata: JSON.stringify({ sub_issues: [11, 12] }),
      github_delivery_id: null,
    });

    const history = await getTransitionHistory(db, "wf-1");
    expect(history).toHaveLength(1);
    expect(history[0].event_type).toBe("triage_complete");
    expect(JSON.parse(history[0].metadata!)).toEqual({ sub_issues: [11, 12] });
  });

  it("deduplicates by github delivery id", async () => {
    await addTransition(db, {
      id: "t-1",
      workflow_id: "wf-1",
      from_state: "TRIAGE",
      to_state: "TRIAGED",
      event_type: "triage_complete",
      triggered_by: "agent",
      metadata: null,
      github_delivery_id: "gh-delivery-123",
    });

    const processed = await hasDeliveryBeenProcessed(db, "gh-delivery-123");
    expect(processed).toBe(true);

    const notProcessed = await hasDeliveryBeenProcessed(db, "gh-delivery-999");
    expect(notProcessed).toBe(false);
  });
});

describe("incrementRetryCount", () => {
  beforeEach(async () => {
    await upsertWorkflow(db, {
      id: "wf-1",
      issue_number: 1,
      repo: "r",
      state: "IMPLEMENTING",
      level: "sub",
      parent_workflow_id: null,
      author: "a",
      intent: "",
    });
  });

  it("increments retry_count by 1", async () => {
    await createAgentSession(db, {
      id: "agent-retry",
      workflow_id: "wf-1",
      role: "implementer",
      worktree_path: null,
      pr_number: null,
    });

    const before = await getAgentSession(db, "agent-retry");
    expect(before!.retry_count).toBe(0);

    await incrementRetryCount(db, "agent-retry");
    const after1 = await getAgentSession(db, "agent-retry");
    expect(after1!.retry_count).toBe(1);

    await incrementRetryCount(db, "agent-retry");
    const after2 = await getAgentSession(db, "agent-retry");
    expect(after2!.retry_count).toBe(2);
  });
});

describe("updateAgentStatus terminal states", () => {
  beforeEach(async () => {
    await upsertWorkflow(db, {
      id: "wf-1",
      issue_number: 1,
      repo: "r",
      state: "IMPLEMENTING",
      level: "sub",
      parent_workflow_id: null,
      author: "a",
      intent: "",
    });
  });

  it("sets completed_at when status is 'failed'", async () => {
    await createAgentSession(db, {
      id: "agent-fail",
      workflow_id: "wf-1",
      role: "implementer",
      worktree_path: null,
      pr_number: null,
    });

    const before = await getAgentSession(db, "agent-fail");
    expect(before!.completed_at).toBeNull();

    await updateAgentStatus(db, "agent-fail", "failed");
    const after = await getAgentSession(db, "agent-fail");
    expect(after!.status).toBe("failed");
    expect(after!.completed_at).not.toBeNull();
    expect(after!.completed_at).toBeGreaterThan(0);
  });

  it("sets completed_at when status is 'timeout'", async () => {
    await createAgentSession(db, {
      id: "agent-timeout",
      workflow_id: "wf-1",
      role: "implementer",
      worktree_path: null,
      pr_number: null,
    });

    const before = await getAgentSession(db, "agent-timeout");
    expect(before!.completed_at).toBeNull();

    await updateAgentStatus(db, "agent-timeout", "timeout");
    const after = await getAgentSession(db, "agent-timeout");
    expect(after!.status).toBe("timeout");
    expect(after!.completed_at).not.toBeNull();
    expect(after!.completed_at).toBeGreaterThan(0);
  });
});

describe("getStaleAgents filtering", () => {
  beforeEach(async () => {
    await upsertWorkflow(db, {
      id: "wf-1",
      issue_number: 1,
      repo: "r",
      state: "IMPLEMENTING",
      level: "sub",
      parent_workflow_id: null,
      author: "a",
      intent: "",
    });
  });

  it("returns only agents with old heartbeats in active statuses", async () => {
    // Create three agents
    await createAgentSession(db, {
      id: "agent-old-running",
      workflow_id: "wf-1",
      role: "implementer",
      worktree_path: null,
      pr_number: null,
    });
    await createAgentSession(db, {
      id: "agent-old-spawning",
      workflow_id: "wf-1",
      role: "qe",
      worktree_path: null,
      pr_number: null,
    });
    await createAgentSession(db, {
      id: "agent-fresh",
      workflow_id: "wf-1",
      role: "implementer",
      worktree_path: null,
      pr_number: null,
    });

    const oldTime = Math.floor(Date.now() / 1000) - 1200; // 20 min ago
    // Make two agents stale
    await db
      .updateTable("agent_sessions")
      .set({ last_heartbeat: oldTime, status: "running" })
      .where("id", "=", "agent-old-running")
      .execute();
    await db
      .updateTable("agent_sessions")
      .set({ last_heartbeat: oldTime, status: "spawning" })
      .where("id", "=", "agent-old-spawning")
      .execute();
    // Keep agent-fresh with recent heartbeat and running status
    await db
      .updateTable("agent_sessions")
      .set({ status: "running" })
      .where("id", "=", "agent-fresh")
      .execute();

    const stale = await getStaleAgents(db);
    expect(stale).toHaveLength(2);
    const ids = stale.map((a) => a.id).sort();
    expect(ids).toEqual(["agent-old-running", "agent-old-spawning"]);
  });
});

describe("getWorkflowByIssue repo scoping", () => {
  it("returns correct workflow when same issue number exists in different repos", async () => {
    await upsertWorkflow(db, {
      id: "wf-repo-a",
      issue_number: 42,
      repo: "owner/repo-a",
      state: "TRIAGE",
      level: "parent",
      parent_workflow_id: null,
      author: "alice",
      intent: "fix in repo-a",
    });
    await upsertWorkflow(db, {
      id: "wf-repo-b",
      issue_number: 42,
      repo: "owner/repo-b",
      state: "PLANNING",
      level: "parent",
      parent_workflow_id: null,
      author: "bob",
      intent: "fix in repo-b",
    });

    const wfA = await getWorkflowByIssue(db, 42, "owner/repo-a");
    expect(wfA).toBeDefined();
    expect(wfA!.id).toBe("wf-repo-a");
    expect(wfA!.intent).toBe("fix in repo-a");

    const wfB = await getWorkflowByIssue(db, 42, "owner/repo-b");
    expect(wfB).toBeDefined();
    expect(wfB!.id).toBe("wf-repo-b");
    expect(wfB!.intent).toBe("fix in repo-b");

    const wfNone = await getWorkflowByIssue(db, 42, "owner/repo-c");
    expect(wfNone).toBeUndefined();
  });
});

describe("transactions", () => {
  it("rolls back on error", async () => {
    await upsertWorkflow(db, {
      id: "wf-tx",
      issue_number: 99,
      repo: "r",
      state: "TRIAGE",
      level: "parent",
      parent_workflow_id: null,
      author: "a",
      intent: "",
    });

    try {
      await withTransaction(db, async (trx) => {
        await trx
          .updateTable("workflows")
          .set({ state: "TRIAGED" })
          .where("id", "=", "wf-tx")
          .execute();
        throw new Error("forced rollback");
      });
    } catch {}

    const wf = await getWorkflow(db, "wf-tx");
    expect(wf!.state).toBe("TRIAGE"); // unchanged
  });
});
