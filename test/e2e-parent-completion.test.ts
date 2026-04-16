import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Kysely } from "kysely";
import { initDatabase, type Database } from "../src/store/database.js";
import {
  getWorkflow,
  upsertWorkflow,
  updateWorkflowState,
  getSubWorkflows,
  addTransition,
  getTransitionHistory,
  withTransaction,
} from "../src/store/queries.js";
import { apply } from "../src/state-machine/engine.js";
import { TERMINAL_STATES, ParentState, SubState } from "../src/state-machine/states.js";
import type { Workflow } from "../src/state-machine/transitions.js";
import type { SideEffect } from "../src/state-machine/effects.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

let db: Kysely<Database>;
let dbPath: string;

const REPO = "test-owner/test-repo";

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `zapbot-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = await initDatabase(dbPath);
});

afterEach(async () => {
  await db.destroy();
  try { fs.unlinkSync(dbPath); } catch {}
  try { fs.unlinkSync(dbPath + "-wal"); } catch {}
  try { fs.unlinkSync(dbPath + "-shm"); } catch {}
});

// ── Helpers ──────────────────────────────────────────────────────────

/** Replicate checkParentCompletion logic from bin/webhook-bridge.ts (lines 263-307).
 *  Returns the side effects that would be executed, or null if no transition occurred. */
async function checkParentCompletion(
  database: Kysely<Database>,
  parentWorkflowId: string,
): Promise<SideEffect[] | null> {
  const result = await withTransaction(database, async (trx) => {
    const parent = await getWorkflow(trx, parentWorkflowId);
    if (!parent || TERMINAL_STATES.has(parent.state)) return null;

    const subs = await getSubWorkflows(trx, parentWorkflowId);
    const allTerminal = subs.length > 0 && subs.every((s) => TERMINAL_STATES.has(s.state));

    if (!allTerminal) return null;

    const parentWf: Workflow = {
      id: parent.id,
      issueNumber: parent.issue_number,
      state: parent.state,
      level: parent.level as "parent" | "sub",
      parentWorkflowId: parent.parent_workflow_id,
      draftReviewCycles: parent.draft_review_cycles,
    };
    const applyResult = apply(parentWf, { type: "all_subs_done", triggeredBy: "system" });
    if (!applyResult) return null;

    await updateWorkflowState(trx, parent.id, applyResult.newState);
    await addTransition(trx, {
      id: `t-${crypto.randomUUID()}`,
      workflow_id: parent.id,
      from_state: applyResult.transition.from,
      to_state: applyResult.transition.to,
      event_type: applyResult.transition.event,
      triggered_by: applyResult.transition.triggeredBy,
      metadata: null,
      github_delivery_id: null,
    });

    return applyResult;
  });

  return result?.sideEffects ?? null;
}

async function insertParent(issueNumber: number, state: string): Promise<string> {
  const id = `wf-test-${issueNumber}`;
  await upsertWorkflow(db, {
    id,
    issue_number: issueNumber,
    repo: REPO,
    state,
    level: "parent",
    parent_workflow_id: null,
    author: "test-author",
    intent: "parent issue",
  });
  return id;
}

async function insertSub(
  issueNumber: number,
  parentId: string,
  state: string,
): Promise<string> {
  const id = `wf-test-${issueNumber}`;
  await upsertWorkflow(db, {
    id,
    issue_number: issueNumber,
    repo: REPO,
    state,
    level: "sub",
    parent_workflow_id: parentId,
    author: "test-author",
    intent: `sub-issue ${issueNumber}`,
  });
  return id;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("E2E: parent completes when all triage sub-issues reach terminal state", () => {
  it("parent stays in TRIAGED while children are in-progress", async () => {
    const parentId = await insertParent(100, ParentState.TRIAGED);
    await insertSub(101, parentId, SubState.DONE);
    await insertSub(102, parentId, SubState.IMPLEMENTING); // not terminal

    const effects = await checkParentCompletion(db, parentId);
    expect(effects).toBeNull();

    const parent = await getWorkflow(db, parentId);
    expect(parent!.state).toBe(ParentState.TRIAGED);
  });

  it("parent transitions to COMPLETED when all children are DONE", async () => {
    const parentId = await insertParent(200, ParentState.TRIAGED);
    await insertSub(201, parentId, SubState.DONE);
    await insertSub(202, parentId, SubState.DONE);

    const effects = await checkParentCompletion(db, parentId);
    expect(effects).not.toBeNull();

    const parent = await getWorkflow(db, parentId);
    expect(parent!.state).toBe(ParentState.COMPLETED);

    // Verify close_issue side effect is produced
    expect(effects!.some((e) => e.type === "close_issue" && e.issueNumber === 200)).toBe(true);
  });

  it("parent GitHub issue is closed (close_issue effect produced)", async () => {
    const parentId = await insertParent(300, ParentState.TRIAGED);
    await insertSub(301, parentId, SubState.DONE);
    await insertSub(302, parentId, SubState.DONE);
    await insertSub(303, parentId, SubState.DONE);

    const effects = await checkParentCompletion(db, parentId);
    expect(effects).not.toBeNull();

    const closeEffects = effects!.filter((e) => e.type === "close_issue");
    expect(closeEffects).toHaveLength(1);
    expect(closeEffects[0]).toEqual({ type: "close_issue", issueNumber: 300 });

    // Verify triaged label is removed
    expect(effects!.some((e) => e.type === "remove_label" && e.label === "triaged")).toBe(true);

    // Verify transition is recorded in history
    const history = await getTransitionHistory(db, parentId);
    expect(history.some((t) => t.from_state === "TRIAGED" && t.to_state === "COMPLETED")).toBe(true);
  });

  it("handles mixed terminal states (DONE + ABANDONED)", async () => {
    const parentId = await insertParent(400, ParentState.TRIAGED);
    await insertSub(401, parentId, SubState.DONE);
    await insertSub(402, parentId, SubState.ABANDONED);
    await insertSub(403, parentId, SubState.DONE);

    const effects = await checkParentCompletion(db, parentId);
    expect(effects).not.toBeNull();

    const parent = await getWorkflow(db, parentId);
    expect(parent!.state).toBe(ParentState.COMPLETED);

    expect(effects!.some((e) => e.type === "close_issue" && e.issueNumber === 400)).toBe(true);
  });

  it("does not complete when some children are in non-terminal states", async () => {
    const parentId = await insertParent(500, ParentState.TRIAGED);
    await insertSub(501, parentId, SubState.DONE);
    await insertSub(502, parentId, SubState.VERIFYING);

    const effects = await checkParentCompletion(db, parentId);
    expect(effects).toBeNull();

    const parent = await getWorkflow(db, parentId);
    expect(parent!.state).toBe(ParentState.TRIAGED);

    // Now move the remaining sub to terminal
    await updateWorkflowState(db, "wf-test-502", SubState.DONE);

    const effects2 = await checkParentCompletion(db, parentId);
    expect(effects2).not.toBeNull();

    const parent2 = await getWorkflow(db, parentId);
    expect(parent2!.state).toBe(ParentState.COMPLETED);
  });

  it("does not complete when parent has no sub-issues", async () => {
    const parentId = await insertParent(600, ParentState.TRIAGED);

    const effects = await checkParentCompletion(db, parentId);
    expect(effects).toBeNull();

    const parent = await getWorkflow(db, parentId);
    expect(parent!.state).toBe(ParentState.TRIAGED);
  });

  it("skips already-completed parent", async () => {
    const parentId = await insertParent(700, ParentState.COMPLETED);
    await insertSub(701, parentId, SubState.DONE);

    const effects = await checkParentCompletion(db, parentId);
    expect(effects).toBeNull();

    const parent = await getWorkflow(db, parentId);
    expect(parent!.state).toBe(ParentState.COMPLETED);
  });

  it("skips already-abandoned parent", async () => {
    const parentId = await insertParent(800, ParentState.ABANDONED);
    await insertSub(801, parentId, SubState.DONE);

    const effects = await checkParentCompletion(db, parentId);
    expect(effects).toBeNull();

    const parent = await getWorkflow(db, parentId);
    expect(parent!.state).toBe(ParentState.ABANDONED);
  });

  it("records exactly one all_subs_done transition", async () => {
    const parentId = await insertParent(900, ParentState.TRIAGED);
    await insertSub(901, parentId, SubState.DONE);
    await insertSub(902, parentId, SubState.ABANDONED);

    await checkParentCompletion(db, parentId);

    const history = await getTransitionHistory(db, parentId);
    const allSubsDoneTransitions = history.filter((t) => t.event_type === "all_subs_done");
    expect(allSubsDoneTransitions).toHaveLength(1);
    expect(allSubsDoneTransitions[0].from_state).toBe("TRIAGED");
    expect(allSubsDoneTransitions[0].to_state).toBe("COMPLETED");
    expect(allSubsDoneTransitions[0].triggered_by).toBe("system");
  });

  it("second call is a no-op after parent already completed", async () => {
    const parentId = await insertParent(1000, ParentState.TRIAGED);
    await insertSub(1001, parentId, SubState.DONE);
    await insertSub(1002, parentId, SubState.DONE);

    // First call completes the parent
    const effects1 = await checkParentCompletion(db, parentId);
    expect(effects1).not.toBeNull();

    // Second call is a no-op (parent already COMPLETED)
    const effects2 = await checkParentCompletion(db, parentId);
    expect(effects2).toBeNull();

    // Only one transition recorded
    const history = await getTransitionHistory(db, parentId);
    const completionTransitions = history.filter((t) => t.to_state === "COMPLETED");
    expect(completionTransitions).toHaveLength(1);
  });

  it("simulates full lifecycle: subs transition one by one, parent completes at the end", async () => {
    const parentId = await insertParent(1100, ParentState.TRIAGED);
    const sub1Id = await insertSub(1101, parentId, SubState.IMPLEMENTING);
    const sub2Id = await insertSub(1102, parentId, SubState.PLANNING);

    // Both subs in-progress: parent stays TRIAGED
    expect(await checkParentCompletion(db, parentId)).toBeNull();

    // Sub 1 reaches DONE
    await updateWorkflowState(db, sub1Id, SubState.DONE);
    expect(await checkParentCompletion(db, parentId)).toBeNull();
    expect((await getWorkflow(db, parentId))!.state).toBe(ParentState.TRIAGED);

    // Sub 2 reaches ABANDONED
    await updateWorkflowState(db, sub2Id, SubState.ABANDONED);
    const effects = await checkParentCompletion(db, parentId);
    expect(effects).not.toBeNull();
    expect((await getWorkflow(db, parentId))!.state).toBe(ParentState.COMPLETED);

    // Verify the completion comment
    expect(effects!.some((e) =>
      e.type === "post_comment" && e.body.includes("All sub-issues are complete")
    )).toBe(true);
  });
});
