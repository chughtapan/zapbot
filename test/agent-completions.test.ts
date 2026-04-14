import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Kysely } from "kysely";
import { initDatabase, type Database } from "../src/store/database.js";
import {
  getWorkflow,
  upsertWorkflow,
  getTransitionHistory,
  getSubWorkflows,
} from "../src/store/queries.js";
import { completeTriageAgent } from "../src/agents/triage.js";
import { completePlannerAgent } from "../src/agents/planner.js";
import { completeQEVerification } from "../src/agents/qe.js";
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

describe("completeTriageAgent", () => {
  it("transitions parent from TRIAGE to TRIAGED and creates sub-workflows", async () => {
    await upsertWorkflow(db, {
      id: "wf-parent-1",
      issue_number: 1,
      repo: "owner/repo",
      state: "TRIAGE",
      level: "parent",
      parent_workflow_id: null,
      author: "alice",
      intent: "big feature",
    });

    await completeTriageAgent(db, "wf-parent-1", [10, 11, 12], "owner/repo", "agent-triage-abc");

    // Parent should be TRIAGED
    const parent = await getWorkflow(db, "wf-parent-1");
    expect(parent).toBeDefined();
    expect(parent!.state).toBe("TRIAGED");

    // Sub-workflows should exist with correct repo-scoped IDs
    const sub10 = await getWorkflow(db, "wf-owner-repo-10");
    expect(sub10).toBeDefined();
    expect(sub10!.state).toBe("PLANNING");
    expect(sub10!.level).toBe("sub");
    expect(sub10!.parent_workflow_id).toBe("wf-parent-1");
    expect(sub10!.author).toBe("alice");
    expect(sub10!.issue_number).toBe(10);
    expect(sub10!.repo).toBe("owner/repo");

    const sub11 = await getWorkflow(db, "wf-owner-repo-11");
    expect(sub11).toBeDefined();
    expect(sub11!.state).toBe("PLANNING");

    const sub12 = await getWorkflow(db, "wf-owner-repo-12");
    expect(sub12).toBeDefined();
    expect(sub12!.state).toBe("PLANNING");

    // Transition should be recorded
    const history = await getTransitionHistory(db, "wf-parent-1");
    expect(history).toHaveLength(1);
    expect(history[0].from_state).toBe("TRIAGE");
    expect(history[0].to_state).toBe("TRIAGED");
    expect(history[0].event_type).toBe("triage_complete");
    expect(history[0].triggered_by).toBe("agent-triage-abc");
    expect(JSON.parse(history[0].metadata!)).toEqual({ sub_issues: [10, 11, 12] });
  });

  it("does nothing if parent is not in TRIAGE state", async () => {
    await upsertWorkflow(db, {
      id: "wf-parent-2",
      issue_number: 2,
      repo: "owner/repo",
      state: "TRIAGED",
      level: "parent",
      parent_workflow_id: null,
      author: "alice",
      intent: "already triaged",
    });

    await completeTriageAgent(db, "wf-parent-2", [20], "owner/repo", "agent-triage");

    // State should remain unchanged
    const parent = await getWorkflow(db, "wf-parent-2");
    expect(parent!.state).toBe("TRIAGED");

    // No sub-workflows created
    const sub = await getWorkflow(db, "wf-owner-repo-20");
    expect(sub).toBeUndefined();

    // No transitions recorded
    const history = await getTransitionHistory(db, "wf-parent-2");
    expect(history).toHaveLength(0);
  });

  it("does nothing if parent workflow does not exist", async () => {
    await completeTriageAgent(db, "wf-nonexistent", [30], "owner/repo", "agent-triage");

    // No sub-workflows created
    const sub = await getWorkflow(db, "wf-owner-repo-30");
    expect(sub).toBeUndefined();

    // No transitions recorded
    const history = await getTransitionHistory(db, "wf-nonexistent");
    expect(history).toHaveLength(0);
  });
});

describe("completePlannerAgent", () => {
  it("transitions workflow from PLANNING to REVIEW", async () => {
    await upsertWorkflow(db, {
      id: "wf-plan-1",
      issue_number: 5,
      repo: "owner/repo",
      state: "PLANNING",
      level: "sub",
      parent_workflow_id: "wf-parent-1",
      author: "bob",
      intent: "implement feature X",
    });

    await completePlannerAgent(db, "wf-plan-1", "agent-planner-abc");

    const wf = await getWorkflow(db, "wf-plan-1");
    expect(wf).toBeDefined();
    expect(wf!.state).toBe("REVIEW");

    const history = await getTransitionHistory(db, "wf-plan-1");
    expect(history).toHaveLength(1);
    expect(history[0].from_state).toBe("PLANNING");
    expect(history[0].to_state).toBe("REVIEW");
    expect(history[0].event_type).toBe("plan_published");
    expect(history[0].triggered_by).toBe("agent-planner-abc");
  });

  it("does nothing if workflow is not in PLANNING state", async () => {
    await upsertWorkflow(db, {
      id: "wf-plan-2",
      issue_number: 6,
      repo: "owner/repo",
      state: "REVIEW",
      level: "sub",
      parent_workflow_id: null,
      author: "bob",
      intent: "already in review",
    });

    await completePlannerAgent(db, "wf-plan-2", "agent-planner");

    const wf = await getWorkflow(db, "wf-plan-2");
    expect(wf!.state).toBe("REVIEW");

    const history = await getTransitionHistory(db, "wf-plan-2");
    expect(history).toHaveLength(0);
  });

  it("does nothing if workflow does not exist", async () => {
    await completePlannerAgent(db, "wf-nonexistent", "agent-planner");

    const history = await getTransitionHistory(db, "wf-nonexistent");
    expect(history).toHaveLength(0);
  });
});

describe("completeQEVerification", () => {
  it("transitions VERIFYING to DONE when passed=true", async () => {
    await upsertWorkflow(db, {
      id: "wf-qe-1",
      issue_number: 7,
      repo: "owner/repo",
      state: "VERIFYING",
      level: "sub",
      parent_workflow_id: null,
      author: "carol",
      intent: "verify feature",
    });

    await completeQEVerification(db, "wf-qe-1", true, "agent-qe-abc");

    const wf = await getWorkflow(db, "wf-qe-1");
    expect(wf).toBeDefined();
    expect(wf!.state).toBe("DONE");

    const history = await getTransitionHistory(db, "wf-qe-1");
    expect(history).toHaveLength(1);
    expect(history[0].from_state).toBe("VERIFYING");
    expect(history[0].to_state).toBe("DONE");
    expect(history[0].event_type).toBe("verified_and_shipped");
    expect(history[0].triggered_by).toBe("agent-qe-abc");
  });

  it("transitions VERIFYING to DRAFT_REVIEW with incremented cycle count when passed=false", async () => {
    await upsertWorkflow(db, {
      id: "wf-qe-2",
      issue_number: 8,
      repo: "owner/repo",
      state: "VERIFYING",
      level: "sub",
      parent_workflow_id: null,
      author: "carol",
      intent: "verify feature",
      draft_review_cycles: 1,
    });

    await completeQEVerification(db, "wf-qe-2", false, "agent-qe-xyz");

    const wf = await getWorkflow(db, "wf-qe-2");
    expect(wf).toBeDefined();
    expect(wf!.state).toBe("DRAFT_REVIEW");
    expect(wf!.draft_review_cycles).toBe(2);

    const history = await getTransitionHistory(db, "wf-qe-2");
    expect(history).toHaveLength(1);
    expect(history[0].from_state).toBe("VERIFYING");
    expect(history[0].to_state).toBe("DRAFT_REVIEW");
    expect(history[0].event_type).toBe("verification_failed");
    expect(history[0].triggered_by).toBe("agent-qe-xyz");
    expect(JSON.parse(history[0].metadata!)).toEqual({ cycles: 2 });
  });

  it("does nothing if workflow is not in VERIFYING state", async () => {
    await upsertWorkflow(db, {
      id: "wf-qe-3",
      issue_number: 9,
      repo: "owner/repo",
      state: "IMPLEMENTING",
      level: "sub",
      parent_workflow_id: null,
      author: "carol",
      intent: "still implementing",
    });

    await completeQEVerification(db, "wf-qe-3", true, "agent-qe");

    const wf = await getWorkflow(db, "wf-qe-3");
    expect(wf!.state).toBe("IMPLEMENTING");

    const history = await getTransitionHistory(db, "wf-qe-3");
    expect(history).toHaveLength(0);
  });
});
