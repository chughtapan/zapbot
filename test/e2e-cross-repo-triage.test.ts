import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Kysely } from "kysely";
import { initDatabase, type Database, type WorkflowTable } from "../src/store/database.js";
import {
  getWorkflow,
  getWorkflowByIssue,
  upsertWorkflow,
  updateWorkflowState,
  getSubWorkflows,
  addTransition,
  getTransitionHistory,
  hasDeliveryBeenProcessed,
  withTransaction,
} from "../src/store/queries.js";
import { apply } from "../src/state-machine/engine.js";
import { ParentState, SubState, TERMINAL_STATES } from "../src/state-machine/states.js";
import type { Workflow } from "../src/state-machine/transitions.js";
import type { WorkflowEvent } from "../src/state-machine/events.js";
import type { SideEffect } from "../src/state-machine/effects.js";
import { mapWebhookToEvent } from "../src/webhook/mapper.js";
import { makeWorkflowId } from "../src/workflow-id.js";
import { resolveWebhookSecret, type RepoMap, type RepoEntry } from "../src/config/loader.js";
import { verifySignature } from "../src/http/verify-signature.js";
import { errorResponse } from "../src/http/error-response.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ── Test infrastructure ───────────────────────────────────────────

const REPO_A = "chughtapan/zapbot";
const REPO_B = "chughtapan/frontend-app";
const SECRET_A = "zapbot-secret-abc";
const SECRET_B = "frontend-secret-xyz";
const BOT_USERNAME = "zapbot[bot]";

let db: Kysely<Database>;
let dbPath: string;
let collectedEffects: Array<SideEffect & { repo: string }>;

function buildTestRepoMap(): RepoMap {
  const map = new Map<string, RepoEntry>();
  map.set(REPO_A, {
    projectName: "zapbot",
    config: {
      repo: REPO_A,
      path: "/home/user/zapbot",
      defaultBranch: "main",
      sessionPrefix: "zap",
      agentRulesFile: ".agent-rules.md",
      scm: {
        plugin: "github",
        webhook: {
          path: "/api/webhooks/github",
          secretEnvVar: "ZAPBOT_API_KEY",
          signatureHeader: "x-hub-signature-256",
          eventHeader: "x-github-event",
        },
      },
    },
  });
  map.set(REPO_B, {
    projectName: "frontend",
    config: {
      repo: REPO_B,
      path: "/home/user/frontend",
      defaultBranch: "main",
      sessionPrefix: "fe",
      agentRulesFile: ".agent-rules.md",
      scm: {
        plugin: "github",
        webhook: {
          path: "/api/webhooks/github",
          secretEnvVar: "ZAPBOT_API_KEY_FRONTEND",
          signatureHeader: "x-hub-signature-256",
          eventHeader: "x-github-event",
        },
      },
    },
  });
  return map;
}

// ── Mini bridge: reproduces core webhook handling logic ────────────
// Uses the real state machine, store, and mapper — but captures side
// effects instead of calling GitHub API or spawning agents.

function toWorkflow(row: WorkflowTable): Workflow {
  return {
    id: row.id,
    issueNumber: row.issue_number,
    state: row.state,
    level: row.level as "parent" | "sub",
    parentWorkflowId: row.parent_workflow_id,
    draftReviewCycles: row.draft_review_cycles,
  };
}

async function createTriageWorkflow(
  repo: string, issueNumber: number, author: string, intent: string, deliveryId: string
): Promise<void> {
  const wfId = makeWorkflowId(repo, issueNumber);
  await upsertWorkflow(db, {
    id: wfId,
    issue_number: issueNumber,
    repo,
    state: "TRIAGE",
    level: "parent",
    parent_workflow_id: null,
    author,
    intent,
  });
  await addTransition(db, {
    id: `t-${crypto.randomUUID()}`,
    workflow_id: wfId,
    from_state: "NEW",
    to_state: "TRIAGE",
    event_type: "workflow_created",
    triggered_by: author,
    metadata: null,
    github_delivery_id: deliveryId,
  });
  collectEffect({ type: "spawn_agent", role: "triage", issueNumber }, repo);
}

function collectEffect(effect: SideEffect, repo: string): void {
  collectedEffects.push({ ...effect, repo });
}

async function checkParentCompletion(parentWorkflowId: string, repo: string): Promise<void> {
  const result = await withTransaction(db, async (trx) => {
    const parent = await getWorkflow(trx, parentWorkflowId);
    if (!parent || TERMINAL_STATES.has(parent.state)) return null;

    const subs = await getSubWorkflows(trx, parentWorkflowId);
    const allTerminal = subs.length > 0 && subs.every((s) => TERMINAL_STATES.has(s.state));
    if (!allTerminal) return null;

    const parentWf = toWorkflow(parent);
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

  if (result) {
    for (const effect of result.sideEffects) collectEffect(effect, repo);
  }
}

async function executeSideEffectsCollect(effects: SideEffect[], repo: string): Promise<void> {
  for (const effect of effects) {
    collectEffect(effect, repo);
    if (effect.type === "check_parent_completion") {
      await checkParentCompletion(effect.parentWorkflowId, repo);
    }
  }
}

/**
 * Simulates the bridge's core webhook handler, using real DB + state machine
 * but capturing side effects instead of hitting GitHub.
 */
async function handleWebhook(
  eventType: string,
  deliveryId: string,
  payload: any
): Promise<{ status: number; body: string }> {
  const repo: string = payload.repository?.full_name || "";

  // Dedup
  if (deliveryId && await hasDeliveryBeenProcessed(db, deliveryId)) {
    return { status: 200, body: "duplicate" };
  }

  // issues.opened with triage label → create parent workflow
  if (eventType === "issues" && payload.action === "opened") {
    const labels: string[] = (payload.issue?.labels || []).map((l: any) => l.name);
    if (labels.includes("triage")) {
      const issueNumber = payload.issue.number;
      const author = payload.sender?.login || "";
      const intent = payload.issue?.title || "";
      await createTriageWorkflow(repo, issueNumber, author, intent, deliveryId);
      return { status: 200, body: "parent workflow created" };
    }
  }

  // issues.opened with planning label → create sub workflow
  if (eventType === "issues" && payload.action === "opened") {
    const labels: string[] = (payload.issue?.labels || []).map((l: any) => l.name);
    if (labels.includes("planning")) {
      const issueNumber = payload.issue.number;
      const author = payload.sender?.login || "";
      const intent = payload.issue?.title || "";
      const body: string = payload.issue?.body || "";
      const wfId = makeWorkflowId(repo, issueNumber);

      const parentMatch = body.match(/Part of #(\d+)/i);
      const parentWorkflowId = parentMatch ? makeWorkflowId(repo, parseInt(parentMatch[1], 10)) : null;

      await upsertWorkflow(db, {
        id: wfId,
        issue_number: issueNumber,
        repo,
        state: "PLANNING",
        level: "sub",
        parent_workflow_id: parentWorkflowId,
        author,
        intent,
      });
      await addTransition(db, {
        id: `t-${crypto.randomUUID()}`,
        workflow_id: wfId,
        from_state: "NEW",
        to_state: "PLANNING",
        event_type: "workflow_created",
        triggered_by: author,
        metadata: null,
        github_delivery_id: deliveryId,
      });
      return { status: 200, body: "sub workflow created" };
    }
  }

  // Map webhook to state machine event
  const mapped = mapWebhookToEvent(eventType, payload, BOT_USERNAME);

  // triage_label_added on existing issue → create parent if none exists
  if (mapped && mapped.event.type === "triage_label_added") {
    const existingWf = await getWorkflowByIssue(db, mapped.issueNumber, repo);
    if (!existingWf) {
      const author = payload.sender?.login || "";
      const intent = payload.issue?.title || "";
      await createTriageWorkflow(repo, mapped.issueNumber, author, intent, deliveryId);
      return { status: 200, body: "parent workflow created" };
    }
  }

  if (!mapped) {
    return { status: 200, body: "no-op" };
  }

  const { event, issueNumber } = mapped;

  // Load workflow
  const wfRow = await getWorkflowByIssue(db, issueNumber, repo);
  if (!wfRow) {
    return { status: 200, body: "no workflow" };
  }

  const workflow = toWorkflow(wfRow);
  const result = apply(workflow, event);
  if (!result) {
    return { status: 200, body: "rejected" };
  }

  // Apply transition
  await withTransaction(db, async (trx) => {
    const stateUpdates: { draft_review_cycles?: number } = {};
    if (result.newState === "DRAFT_REVIEW" && workflow.state === "VERIFYING") {
      stateUpdates.draft_review_cycles = workflow.draftReviewCycles + 1;
    }
    await updateWorkflowState(trx, workflow.id, result.newState, stateUpdates);
    await addTransition(trx, {
      id: `t-${crypto.randomUUID()}`,
      workflow_id: workflow.id,
      from_state: result.transition.from,
      to_state: result.transition.to,
      event_type: result.transition.event,
      triggered_by: result.transition.triggeredBy,
      metadata: null,
      github_delivery_id: deliveryId || null,
    });
  });

  await executeSideEffectsCollect(result.sideEffects, repo);
  return { status: 200, body: `${result.transition.from} → ${result.transition.to}` };
}

// ── Webhook payload builders ──────────────────────────────────────

function triageIssueOpened(repo: string, issueNumber: number, title: string, actor: string) {
  return {
    action: "opened",
    issue: { number: issueNumber, title, body: "", labels: [{ name: "triage" }] },
    sender: { login: actor },
    repository: { full_name: repo },
  };
}

function triageLabelAdded(repo: string, issueNumber: number, actor: string) {
  return {
    action: "labeled",
    label: { name: "triage" },
    issue: { number: issueNumber, title: "Test issue" },
    sender: { login: actor },
    repository: { full_name: repo },
  };
}

function subIssueOpened(repo: string, issueNumber: number, title: string, parentIssueNumber: number, actor: string) {
  return {
    action: "opened",
    issue: {
      number: issueNumber,
      title,
      body: `Part of #${parentIssueNumber}\n\nImplement ${title}`,
      labels: [{ name: "planning" }],
    },
    sender: { login: actor },
    repository: { full_name: repo },
  };
}

function planApprovedLabel(repo: string, issueNumber: number, actor: string) {
  return {
    action: "labeled",
    label: { name: "plan-approved" },
    issue: { number: issueNumber, title: "Sub issue" },
    sender: { login: actor },
    repository: { full_name: repo },
  };
}

function draftPrOpened(repo: string, prNumber: number, linkedIssue: number, actor: string) {
  return {
    action: "opened",
    pull_request: {
      number: prNumber,
      draft: true,
      body: `Closes #${linkedIssue}`,
    },
    sender: { login: actor },
    repository: { full_name: repo },
  };
}

function prReadyForReview(repo: string, prNumber: number, linkedIssue: number, actor: string) {
  return {
    action: "ready_for_review",
    pull_request: {
      number: prNumber,
      body: `Closes #${linkedIssue}`,
    },
    sender: { login: actor },
    repository: { full_name: repo },
  };
}

function prMerged(repo: string, prNumber: number, linkedIssue: number, actor: string) {
  return {
    action: "closed",
    pull_request: {
      number: prNumber,
      merged: true,
      body: `Closes #${linkedIssue}`,
    },
    sender: { login: actor },
    repository: { full_name: repo },
  };
}

// ── Test lifecycle ────────────────────────────────────────────────

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `zapbot-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = await initDatabase(dbPath);
  collectedEffects = [];
});

afterEach(async () => {
  await db.destroy();
  try { fs.unlinkSync(dbPath); } catch {}
  try { fs.unlinkSync(dbPath + "-wal"); } catch {}
  try { fs.unlinkSync(dbPath + "-shm"); } catch {}
});

// ── Tests ─────────────────────────────────────────────────────────

describe("E2E: cross-repo triage", () => {
  describe("triage workflow creation", () => {
    it("creates parent workflow in TRIAGE for repo A via issues.opened", async () => {
      const payload = triageIssueOpened(REPO_A, 1, "Refactor auth module", "alice");
      const result = await handleWebhook("issues", "del-1", payload);

      expect(result.body).toBe("parent workflow created");
      const wf = await getWorkflowByIssue(db, 1, REPO_A);
      expect(wf).toBeDefined();
      expect(wf!.state).toBe("TRIAGE");
      expect(wf!.level).toBe("parent");
      expect(wf!.repo).toBe(REPO_A);
      expect(wf!.author).toBe("alice");
      expect(wf!.intent).toBe("Refactor auth module");
    });

    it("creates parent workflow in TRIAGE for repo B via issues.labeled", async () => {
      const payload = triageLabelAdded(REPO_B, 5, "bob");
      const result = await handleWebhook("issues", "del-2", payload);

      expect(result.body).toBe("parent workflow created");
      const wf = await getWorkflowByIssue(db, 5, REPO_B);
      expect(wf).toBeDefined();
      expect(wf!.state).toBe("TRIAGE");
      expect(wf!.level).toBe("parent");
      expect(wf!.repo).toBe(REPO_B);
    });

    it("spawns triage agent as side effect", async () => {
      await handleWebhook("issues", "del-3", triageIssueOpened(REPO_A, 2, "Add API", "alice"));
      const triageEffects = collectedEffects.filter(
        (e) => e.type === "spawn_agent" && e.role === "triage"
      );
      expect(triageEffects).toHaveLength(1);
      expect(triageEffects[0].repo).toBe(REPO_A);
    });
  });

  describe("cross-repo isolation", () => {
    it("same issue number in different repos produces different workflow IDs", async () => {
      await handleWebhook("issues", "del-a1", triageIssueOpened(REPO_A, 10, "Issue A", "alice"));
      await handleWebhook("issues", "del-b1", triageIssueOpened(REPO_B, 10, "Issue B", "bob"));

      const wfA = await getWorkflowByIssue(db, 10, REPO_A);
      const wfB = await getWorkflowByIssue(db, 10, REPO_B);

      expect(wfA).toBeDefined();
      expect(wfB).toBeDefined();
      expect(wfA!.id).not.toBe(wfB!.id);
      expect(wfA!.repo).toBe(REPO_A);
      expect(wfB!.repo).toBe(REPO_B);
      expect(wfA!.intent).toBe("Issue A");
      expect(wfB!.intent).toBe("Issue B");
    });

    it("triage events on repo A do not affect repo B workflows", async () => {
      await handleWebhook("issues", "del-iso1", triageIssueOpened(REPO_A, 20, "Repo A only", "alice"));
      const wfB = await getWorkflowByIssue(db, 20, REPO_B);
      expect(wfB).toBeUndefined();
    });

    it("sub-issues link to correct parent within the same repo", async () => {
      // Create parents in both repos with same issue number
      await handleWebhook("issues", "del-p1", triageIssueOpened(REPO_A, 1, "Parent A", "alice"));
      await handleWebhook("issues", "del-p2", triageIssueOpened(REPO_B, 1, "Parent B", "bob"));

      // Create sub-issues: #2 in repo A linked to #1, #2 in repo B linked to #1
      await handleWebhook("issues", "del-s1", subIssueOpened(REPO_A, 2, "Sub A", 1, "triage-agent"));
      await handleWebhook("issues", "del-s2", subIssueOpened(REPO_B, 2, "Sub B", 1, "triage-agent"));

      const subA = await getWorkflowByIssue(db, 2, REPO_A);
      const subB = await getWorkflowByIssue(db, 2, REPO_B);

      expect(subA!.parent_workflow_id).toBe(makeWorkflowId(REPO_A, 1));
      expect(subB!.parent_workflow_id).toBe(makeWorkflowId(REPO_B, 1));
      expect(subA!.parent_workflow_id).not.toBe(subB!.parent_workflow_id);
    });
  });

  describe("sub-issue creation", () => {
    it("creates sub workflow in PLANNING linked to parent", async () => {
      await handleWebhook("issues", "del-p", triageIssueOpened(REPO_A, 1, "Parent", "alice"));
      await handleWebhook("issues", "del-s", subIssueOpened(REPO_A, 2, "Sub task 1", 1, "triage-agent"));

      const sub = await getWorkflowByIssue(db, 2, REPO_A);
      expect(sub).toBeDefined();
      expect(sub!.state).toBe("PLANNING");
      expect(sub!.level).toBe("sub");
      expect(sub!.parent_workflow_id).toBe(makeWorkflowId(REPO_A, 1));
      expect(sub!.repo).toBe(REPO_A);
    });

    it("creates multiple sub-issues for one parent", async () => {
      await handleWebhook("issues", "del-p", triageIssueOpened(REPO_A, 1, "Big feature", "alice"));
      await handleWebhook("issues", "del-s1", subIssueOpened(REPO_A, 2, "Sub 1", 1, "triage-agent"));
      await handleWebhook("issues", "del-s2", subIssueOpened(REPO_A, 3, "Sub 2", 1, "triage-agent"));
      await handleWebhook("issues", "del-s3", subIssueOpened(REPO_A, 4, "Sub 3", 1, "triage-agent"));

      const parentId = makeWorkflowId(REPO_A, 1);
      const subs = await getSubWorkflows(db, parentId);
      expect(subs).toHaveLength(3);
      expect(subs.map((s) => s.issue_number).sort()).toEqual([2, 3, 4]);
    });
  });

  describe("triage complete → parent state transition", () => {
    it("transitions parent from TRIAGE to TRIAGED on triage_complete", async () => {
      await handleWebhook("issues", "del-p", triageIssueOpened(REPO_A, 1, "Parent", "alice"));

      // Manually apply triage_complete (bridge receives this from agent callback)
      const wfRow = await getWorkflowByIssue(db, 1, REPO_A);
      const wf = toWorkflow(wfRow!);
      const event: WorkflowEvent = { type: "triage_complete", triggeredBy: "triage-agent", subIssueNumbers: [2, 3] };
      const result = apply(wf, event);

      expect(result).not.toBeNull();
      expect(result!.newState).toBe(ParentState.TRIAGED);

      await updateWorkflowState(db, wf.id, result!.newState);
      const updated = await getWorkflowByIssue(db, 1, REPO_A);
      expect(updated!.state).toBe("TRIAGED");
    });
  });

  describe("full sub-issue lifecycle through webhooks", () => {
    it("PLANNING → IMPLEMENTING on plan-approved label", async () => {
      await handleWebhook("issues", "del-p", triageIssueOpened(REPO_A, 1, "Parent", "alice"));
      await handleWebhook("issues", "del-s", subIssueOpened(REPO_A, 2, "Sub", 1, "triage-agent"));

      collectedEffects = [];
      const result = await handleWebhook("issues", "del-approve", planApprovedLabel(REPO_A, 2, "reviewer"));

      expect(result.body).toContain("IMPLEMENTING");
      const sub = await getWorkflowByIssue(db, 2, REPO_A);
      expect(sub!.state).toBe("IMPLEMENTING");

      const spawnEffects = collectedEffects.filter((e) => e.type === "spawn_agent" && e.role === "implementer");
      expect(spawnEffects).toHaveLength(1);
    });

    it("IMPLEMENTING → DRAFT_REVIEW on draft PR opened", async () => {
      await handleWebhook("issues", "d-p", triageIssueOpened(REPO_A, 1, "Parent", "alice"));
      await handleWebhook("issues", "d-s", subIssueOpened(REPO_A, 2, "Sub", 1, "agent"));
      await handleWebhook("issues", "d-a", planApprovedLabel(REPO_A, 2, "reviewer"));

      const result = await handleWebhook("pull_request", "d-pr", draftPrOpened(REPO_A, 10, 2, "impl-agent"));
      expect(result.body).toContain("DRAFT_REVIEW");

      const sub = await getWorkflowByIssue(db, 2, REPO_A);
      expect(sub!.state).toBe("DRAFT_REVIEW");
    });

    it("DRAFT_REVIEW → VERIFYING on PR ready for review", async () => {
      await handleWebhook("issues", "d-p", triageIssueOpened(REPO_A, 1, "Parent", "alice"));
      await handleWebhook("issues", "d-s", subIssueOpened(REPO_A, 2, "Sub", 1, "agent"));
      await handleWebhook("issues", "d-a", planApprovedLabel(REPO_A, 2, "reviewer"));
      await handleWebhook("pull_request", "d-pr", draftPrOpened(REPO_A, 10, 2, "impl-agent"));

      collectedEffects = [];
      const result = await handleWebhook("pull_request", "d-rdy", prReadyForReview(REPO_A, 10, 2, "impl-agent"));
      expect(result.body).toContain("VERIFYING");

      const sub = await getWorkflowByIssue(db, 2, REPO_A);
      expect(sub!.state).toBe("VERIFYING");

      const qeEffects = collectedEffects.filter((e) => e.type === "spawn_agent" && e.role === "qe");
      expect(qeEffects).toHaveLength(1);
    });

    it("VERIFYING → DONE on PR merged, triggers parent completion check", async () => {
      // Setup parent and single sub
      await handleWebhook("issues", "d-p", triageIssueOpened(REPO_A, 1, "Parent", "alice"));
      await handleWebhook("issues", "d-s", subIssueOpened(REPO_A, 2, "Sub", 1, "agent"));
      await handleWebhook("issues", "d-a", planApprovedLabel(REPO_A, 2, "reviewer"));
      await handleWebhook("pull_request", "d-pr", draftPrOpened(REPO_A, 10, 2, "impl-agent"));
      await handleWebhook("pull_request", "d-rdy", prReadyForReview(REPO_A, 10, 2, "impl-agent"));

      // Transition parent to TRIAGED so completion check works
      const parentWf = await getWorkflowByIssue(db, 1, REPO_A);
      await updateWorkflowState(db, parentWf!.id, ParentState.TRIAGED);

      collectedEffects = [];
      const result = await handleWebhook("pull_request", "d-merge", prMerged(REPO_A, 10, 2, "qe-agent"));
      expect(result.body).toContain("DONE");

      const sub = await getWorkflowByIssue(db, 2, REPO_A);
      expect(sub!.state).toBe("DONE");

      // Parent should be COMPLETED (all subs done)
      const parent = await getWorkflowByIssue(db, 1, REPO_A);
      expect(parent!.state).toBe("COMPLETED");

      // Verify close_issue effects were collected
      const closeEffects = collectedEffects.filter((e) => e.type === "close_issue");
      expect(closeEffects.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("full cross-repo triage: parallel repos", () => {
    it("runs independent triage workflows in both repos simultaneously", async () => {
      // Create parent issues in both repos
      await handleWebhook("issues", "del-a-p", triageIssueOpened(REPO_A, 1, "Auth refactor", "alice"));
      await handleWebhook("issues", "del-b-p", triageIssueOpened(REPO_B, 1, "UI redesign", "bob"));

      // Create sub-issues in both repos
      await handleWebhook("issues", "del-a-s1", subIssueOpened(REPO_A, 2, "Auth: add OAuth", 1, "agent"));
      await handleWebhook("issues", "del-a-s2", subIssueOpened(REPO_A, 3, "Auth: remove basic", 1, "agent"));
      await handleWebhook("issues", "del-b-s1", subIssueOpened(REPO_B, 2, "UI: header", 1, "agent"));

      // Transition parents to TRIAGED
      await updateWorkflowState(db, makeWorkflowId(REPO_A, 1), ParentState.TRIAGED);
      await updateWorkflowState(db, makeWorkflowId(REPO_B, 1), ParentState.TRIAGED);

      // Approve and implement sub in repo B
      await handleWebhook("issues", "del-b-approve", planApprovedLabel(REPO_B, 2, "reviewer"));
      await handleWebhook("pull_request", "del-b-pr", draftPrOpened(REPO_B, 5, 2, "agent"));
      await handleWebhook("pull_request", "del-b-rdy", prReadyForReview(REPO_B, 5, 2, "agent"));

      collectedEffects = [];
      await handleWebhook("pull_request", "del-b-merge", prMerged(REPO_B, 5, 2, "qe-agent"));

      // Repo B's sub is DONE and parent is COMPLETED (only 1 sub)
      const subB = await getWorkflowByIssue(db, 2, REPO_B);
      expect(subB!.state).toBe("DONE");
      const parentB = await getWorkflowByIssue(db, 1, REPO_B);
      expect(parentB!.state).toBe("COMPLETED");

      // Repo A's parent should still be TRIAGED (subs not done)
      const parentA = await getWorkflowByIssue(db, 1, REPO_A);
      expect(parentA!.state).toBe("TRIAGED");

      // Repo A's subs should still be PLANNING
      const subA1 = await getWorkflowByIssue(db, 2, REPO_A);
      const subA2 = await getWorkflowByIssue(db, 3, REPO_A);
      expect(subA1!.state).toBe("PLANNING");
      expect(subA2!.state).toBe("PLANNING");
    });

    it("completing all subs in repo A does not affect repo B", async () => {
      // Setup both repos
      await handleWebhook("issues", "d-a-p", triageIssueOpened(REPO_A, 1, "A", "alice"));
      await handleWebhook("issues", "d-b-p", triageIssueOpened(REPO_B, 1, "B", "bob"));
      await handleWebhook("issues", "d-a-s", subIssueOpened(REPO_A, 2, "Sub A", 1, "agent"));
      await handleWebhook("issues", "d-b-s", subIssueOpened(REPO_B, 2, "Sub B", 1, "agent"));

      await updateWorkflowState(db, makeWorkflowId(REPO_A, 1), ParentState.TRIAGED);
      await updateWorkflowState(db, makeWorkflowId(REPO_B, 1), ParentState.TRIAGED);

      // Complete repo A's sub through full lifecycle
      await handleWebhook("issues", "d-a-apr", planApprovedLabel(REPO_A, 2, "reviewer"));
      await handleWebhook("pull_request", "d-a-pr", draftPrOpened(REPO_A, 10, 2, "agent"));
      await handleWebhook("pull_request", "d-a-rdy", prReadyForReview(REPO_A, 10, 2, "agent"));
      await handleWebhook("pull_request", "d-a-mrg", prMerged(REPO_A, 10, 2, "qe"));

      // Repo A: parent COMPLETED
      const parentA = await getWorkflowByIssue(db, 1, REPO_A);
      expect(parentA!.state).toBe("COMPLETED");

      // Repo B: still TRIAGED, sub still PLANNING
      const parentB = await getWorkflowByIssue(db, 1, REPO_B);
      expect(parentB!.state).toBe("TRIAGED");
      const subB = await getWorkflowByIssue(db, 2, REPO_B);
      expect(subB!.state).toBe("PLANNING");
    });
  });

  describe("webhook deduplication", () => {
    it("rejects duplicate delivery IDs", async () => {
      const payload = triageIssueOpened(REPO_A, 1, "Test", "alice");
      const r1 = await handleWebhook("issues", "dup-1", payload);
      expect(r1.body).toBe("parent workflow created");

      const r2 = await handleWebhook("issues", "dup-1", payload);
      expect(r2.body).toBe("duplicate");
    });
  });

  describe("transition history", () => {
    it("records full transition audit trail for triage workflow", async () => {
      await handleWebhook("issues", "d-p", triageIssueOpened(REPO_A, 1, "Parent", "alice"));
      await handleWebhook("issues", "d-s", subIssueOpened(REPO_A, 2, "Sub", 1, "agent"));
      await handleWebhook("issues", "d-a", planApprovedLabel(REPO_A, 2, "reviewer"));

      const wfId = makeWorkflowId(REPO_A, 2);
      const history = await getTransitionHistory(db, wfId);

      expect(history.length).toBeGreaterThanOrEqual(2);
      expect(history[0].from_state).toBe("NEW");
      expect(history[0].to_state).toBe("PLANNING");
      expect(history[1].from_state).toBe("PLANNING");
      expect(history[1].to_state).toBe("IMPLEMENTING");
    });
  });

  describe("bot self-loop prevention", () => {
    it("ignores label events from bot user", async () => {
      await handleWebhook("issues", "d-p", triageIssueOpened(REPO_A, 1, "Parent", "alice"));
      await handleWebhook("issues", "d-s", subIssueOpened(REPO_A, 2, "Sub", 1, "agent"));

      // Bot adds plan-approved label — should be ignored
      const botPayload = planApprovedLabel(REPO_A, 2, BOT_USERNAME);
      const result = await handleWebhook("issues", "d-bot", botPayload);
      expect(result.body).toBe("no-op");

      // Sub should still be in PLANNING
      const sub = await getWorkflowByIssue(db, 2, REPO_A);
      expect(sub!.state).toBe("PLANNING");
    });
  });

  describe("side effect collection", () => {
    it("collects correct effects for triage workflow creation", async () => {
      collectedEffects = [];
      await handleWebhook("issues", "d-1", triageIssueOpened(REPO_A, 1, "Parent", "alice"));

      expect(collectedEffects).toHaveLength(1);
      expect(collectedEffects[0].type).toBe("spawn_agent");
      expect((collectedEffects[0] as any).role).toBe("triage");
      expect(collectedEffects[0].repo).toBe(REPO_A);
    });

    it("collects label swap effects on state transitions", async () => {
      await handleWebhook("issues", "d-p", triageIssueOpened(REPO_A, 1, "Parent", "alice"));
      await handleWebhook("issues", "d-s", subIssueOpened(REPO_A, 2, "Sub", 1, "agent"));

      collectedEffects = [];
      await handleWebhook("issues", "d-a", planApprovedLabel(REPO_A, 2, "reviewer"));

      const removeLabels = collectedEffects.filter((e) => e.type === "remove_label");
      const addLabels = collectedEffects.filter((e) => e.type === "add_label");
      expect(removeLabels.some((e) => (e as any).label === "planning")).toBe(true);
      expect(addLabels.some((e) => (e as any).label === "implementing")).toBe(true);
    });
  });
});

// ── Per-repo webhook signature verification ───────────────────────

describe("E2E: cross-repo webhook signatures", () => {
  const repoMap = buildTestRepoMap();

  async function signPayload(payload: string, secret: string): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
    return `sha256=${Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  }

  async function simulateWebhookAuth(
    repoFullName: string,
    signingSecret: string,
    sharedSecret: string
  ): Promise<{ status: number }> {
    // Reject unconfigured repos
    if (repoMap.size > 0 && repoFullName && !repoMap.has(repoFullName)) {
      return { status: 403 };
    }
    const secret = resolveWebhookSecret(repoFullName, repoMap, sharedSecret);
    const payload = JSON.stringify({ repository: { full_name: repoFullName } });
    const sig = await signPayload(payload, signingSecret);
    const valid = await verifySignature(payload, sig, secret);
    return { status: valid ? 200 : 401 };
  }

  beforeEach(() => {
    process.env.ZAPBOT_API_KEY_FRONTEND = SECRET_B;
  });

  afterEach(() => {
    delete process.env.ZAPBOT_API_KEY_FRONTEND;
  });

  it("accepts repo A webhook signed with shared secret", async () => {
    const result = await simulateWebhookAuth(REPO_A, SECRET_A, SECRET_A);
    expect(result.status).toBe(200);
  });

  it("accepts repo B webhook signed with per-repo secret", async () => {
    const result = await simulateWebhookAuth(REPO_B, SECRET_B, SECRET_A);
    expect(result.status).toBe(200);
  });

  it("rejects repo B webhook signed with shared secret (wrong)", async () => {
    const result = await simulateWebhookAuth(REPO_B, SECRET_A, SECRET_A);
    expect(result.status).toBe(401);
  });

  it("rejects cross-repo secret (repo A secret used for repo B)", async () => {
    const result = await simulateWebhookAuth(REPO_B, SECRET_A, SECRET_A);
    expect(result.status).toBe(401);
  });

  it("rejects unconfigured repo with 403", async () => {
    const result = await simulateWebhookAuth("evil/hacker", SECRET_A, SECRET_A);
    expect(result.status).toBe(403);
  });
});

// ── Live server: cross-repo triage HTTP integration ───────────────

describe("E2E: cross-repo triage via HTTP", () => {
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  const repoMap = buildTestRepoMap();

  async function signPayload(payload: string, secret: string): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
    return `sha256=${Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  }

  beforeEach(() => {
    process.env.ZAPBOT_API_KEY_FRONTEND = SECRET_B;

    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/healthz") return new Response("ok", { status: 200 });

        if (url.pathname === "/api/webhooks/github" && req.method === "POST") {
          const body = await req.text();
          let payload: any;
          try { payload = JSON.parse(body); } catch {
            return errorResponse(400, "invalid_request", "Invalid JSON");
          }

          const repoFullName = payload.repository?.full_name || "";
          if (repoMap.size > 0 && repoFullName && !repoMap.has(repoFullName)) {
            return errorResponse(403, "configuration_error", `Repo '${repoFullName}' not configured`);
          }

          const secret = resolveWebhookSecret(repoFullName, repoMap, SECRET_A);
          const sig = req.headers.get("x-hub-signature-256");
          if (!(await verifySignature(body, sig, secret))) {
            return errorResponse(401, "signature_error", "Bad signature");
          }

          const eventType = req.headers.get("x-github-event") || "";
          const deliveryId = req.headers.get("x-github-delivery") || "";

          const result = await handleWebhook(eventType, deliveryId, payload);
          return new Response(result.body, { status: result.status });
        }

        // Workflow state query
        if (url.pathname.match(/^\/api\/workflows\/(\d+)$/) && req.method === "GET") {
          const auth = req.headers.get("authorization");
          if (auth !== `Bearer ${SECRET_A}`) {
            return errorResponse(401, "authentication_error", "Invalid API key");
          }
          const issueNumber = parseInt(url.pathname.split("/").pop()!, 10);
          const repo = url.searchParams.get("repo") || "";
          const wf = await getWorkflowByIssue(db, issueNumber, repo);
          if (!wf) return errorResponse(404, "not_found", `No workflow for #${issueNumber}`);

          const subs = wf.level === "parent" ? await getSubWorkflows(db, wf.id) : [];
          return Response.json({ workflow: wf, subWorkflows: subs });
        }

        return errorResponse(404, "not_found", "Not found");
      },
    });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterEach(() => {
    server.stop();
    delete process.env.ZAPBOT_API_KEY_FRONTEND;
  });

  async function sendWebhook(
    eventType: string,
    payload: any,
    secret: string,
    deliveryId?: string
  ): Promise<Response> {
    const body = JSON.stringify(payload);
    const sig = await signPayload(body, secret);
    return fetch(`${baseUrl}/api/webhooks/github`, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sig,
        "x-github-event": eventType,
        "x-github-delivery": deliveryId || crypto.randomUUID(),
      },
    });
  }

  it("accepts triage webhook for repo A and creates workflow", async () => {
    const payload = triageIssueOpened(REPO_A, 1, "Test triage", "alice");
    const resp = await sendWebhook("issues", payload, SECRET_A);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("parent workflow created");

    // Query workflow via API
    const wfResp = await fetch(`${baseUrl}/api/workflows/1?repo=${REPO_A}`, {
      headers: { authorization: `Bearer ${SECRET_A}` },
    });
    expect(wfResp.status).toBe(200);
    const data = await wfResp.json();
    expect(data.workflow.state).toBe("TRIAGE");
    expect(data.workflow.repo).toBe(REPO_A);
  });

  it("accepts triage webhook for repo B with per-repo secret", async () => {
    const payload = triageIssueOpened(REPO_B, 1, "Frontend triage", "bob");
    const resp = await sendWebhook("issues", payload, SECRET_B);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("parent workflow created");
  });

  it("rejects repo B webhook signed with repo A secret", async () => {
    const payload = triageIssueOpened(REPO_B, 1, "Malicious", "eve");
    const resp = await sendWebhook("issues", payload, SECRET_A);
    expect(resp.status).toBe(401);
  });

  it("rejects unconfigured repo webhook", async () => {
    const payload = triageIssueOpened("unknown/repo", 1, "Bad", "eve");
    const resp = await sendWebhook("issues", payload, SECRET_A);
    expect(resp.status).toBe(403);
  });

  it("creates sub-issues and queries them through workflow API", async () => {
    // Create parent
    await sendWebhook("issues", triageIssueOpened(REPO_A, 1, "Parent", "alice"), SECRET_A);
    // Create subs
    await sendWebhook("issues", subIssueOpened(REPO_A, 2, "Sub 1", 1, "agent"), SECRET_A);
    await sendWebhook("issues", subIssueOpened(REPO_A, 3, "Sub 2", 1, "agent"), SECRET_A);

    // Query parent and verify subs are listed
    const resp = await fetch(`${baseUrl}/api/workflows/1?repo=${REPO_A}`, {
      headers: { authorization: `Bearer ${SECRET_A}` },
    });
    const data = await resp.json();
    expect(data.workflow.level).toBe("parent");
    expect(data.subWorkflows).toHaveLength(2);
    expect(data.subWorkflows.map((s: any) => s.issue_number).sort()).toEqual([2, 3]);
  });

  it("runs full triage lifecycle across two repos via HTTP", async () => {
    // Triage in both repos
    await sendWebhook("issues", triageIssueOpened(REPO_A, 1, "A parent", "alice"), SECRET_A);
    await sendWebhook("issues", triageIssueOpened(REPO_B, 1, "B parent", "bob"), SECRET_B);

    // Sub-issues
    await sendWebhook("issues", subIssueOpened(REPO_A, 2, "A sub", 1, "agent"), SECRET_A);
    await sendWebhook("issues", subIssueOpened(REPO_B, 2, "B sub", 1, "agent"), SECRET_B);

    // Transition parents to TRIAGED
    await updateWorkflowState(db, makeWorkflowId(REPO_A, 1), ParentState.TRIAGED);
    await updateWorkflowState(db, makeWorkflowId(REPO_B, 1), ParentState.TRIAGED);

    // Complete repo B sub lifecycle
    await sendWebhook("issues", planApprovedLabel(REPO_B, 2, "reviewer"), SECRET_B);
    await sendWebhook("pull_request", draftPrOpened(REPO_B, 5, 2, "agent"), SECRET_B);
    await sendWebhook("pull_request", prReadyForReview(REPO_B, 5, 2, "agent"), SECRET_B);
    await sendWebhook("pull_request", prMerged(REPO_B, 5, 2, "qe"), SECRET_B);

    // Repo B: parent completed
    const respB = await fetch(`${baseUrl}/api/workflows/1?repo=${REPO_B}`, {
      headers: { authorization: `Bearer ${SECRET_A}` },
    });
    const dataB = await respB.json();
    expect(dataB.workflow.state).toBe("COMPLETED");

    // Repo A: parent still triaged
    const respA = await fetch(`${baseUrl}/api/workflows/1?repo=${REPO_A}`, {
      headers: { authorization: `Bearer ${SECRET_A}` },
    });
    const dataA = await respA.json();
    expect(dataA.workflow.state).toBe("TRIAGED");
  });
});
