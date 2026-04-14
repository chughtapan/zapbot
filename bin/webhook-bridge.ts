import { Kysely } from "kysely";
import { initDatabase, type Database } from "../src/store/database.js";
import {
  getWorkflow,
  getWorkflowByIssue,
  upsertWorkflow,
  updateWorkflowState,
  getSubWorkflows,
  addTransition,
  getTransitionHistory,
  getAgentSessions,
  getAgentSession,
  updateAgentHeartbeat,
  updateAgentStatus,
  hasDeliveryBeenProcessed,
  withTransaction,
} from "../src/store/queries.js";
import { apply } from "../src/state-machine/engine.js";
import { LABEL_TO_STATE, TERMINAL_STATES, STATE_TO_LABEL } from "../src/state-machine/states.js";
import type { WorkflowEvent } from "../src/state-machine/events.js";
import type { SideEffect } from "../src/state-machine/effects.js";
import type { Workflow } from "../src/state-machine/transitions.js";
import { spawnAgent, cancelPendingRetries, type AgentRole, type AgentFailureHandler } from "../src/agents/spawner.js";
import { startHeartbeatChecker, stopHeartbeatChecker } from "../src/agents/heartbeat.js";
import type { WorkflowTable } from "../src/store/database.js";
import { createLogger } from "../src/logger.js";
import { loadConfig, resolveWebhookSecret, type RepoMap } from "../src/config/loader.js";

// Prevent crashes from unhandled async errors
process.on("unhandledRejection", (err) => {
  console.error("[bridge] Unhandled rejection (non-fatal):", err instanceof Error ? err.message : err);
});

const log = createLogger("bridge");

// ── Helpers ─────────────────────────────────────────────────────────

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

function allAgentsDead(agents: { status: string }[]): boolean {
  return agents.length > 0 && agents.every((a) => a.status === "failed" || a.status === "timeout");
}

// ── Agent failure recovery ─────────────────────────────────────────

async function onAgentFailed(database: Kysely<Database>, agentId: string): Promise<void> {
  const agent = await getAgentSession(database, agentId);
  if (!agent) return;

  const wf = await getWorkflow(database, agent.workflow_id);
  if (!wf || TERMINAL_STATES.has(wf.state)) return;

  const agents = await getAgentSessions(database, wf.id);
  if (!allAgentsDead(agents)) return;

  log.warn(`All agents failed for ${wf.id} in state ${wf.state}`, { workflow: wf.id, state: wf.state });

  await executeSideEffects([{
    type: "post_comment",
    issueNumber: wf.issue_number,
    body: `Zapbot: All agents for this workflow have failed (state: \`${wf.state}\`). Remove and re-add the triggering label to retry, or add \`abandoned\` to stop.`,
  }], wf.repo);
}

// ── Configuration ───────────────────────────────────────────────────

const PORT = parseInt(process.env.ZAPBOT_PORT || "3000", 10);
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
if (!WEBHOOK_SECRET) {
  console.error("[bridge] GITHUB_WEBHOOK_SECRET is required. Set it in .env or export it.");
  process.exit(1);
}
const BOT_USERNAME = process.env.ZAPBOT_BOT_USERNAME || "zapbot[bot]";
const AO_URL = process.env.AO_URL || "http://localhost:3001";

// Multi-repo config: loaded from agent-orchestrator.yaml or ZAPBOT_REPO env var
const { repoMap } = loadConfig(process.env.ZAPBOT_CONFIG || undefined);

// ── Plannotator callback token store ────────────────────────────────
// Maps callback tokens to { issueNumber, repo, createdAt } so plannotator
// callbacks resolve to the correct repo without relying on a global env var.
// Tokens expire after TOKEN_TTL_MS to prevent unbounded memory growth.
const callbackTokens = new Map<string, { issueNumber: number; repo: string; createdAt: number }>();
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function pruneExpiredTokens(): void {
  const now = Date.now();
  for (const [key, val] of callbackTokens) {
    if (now - val.createdAt > TOKEN_TTL_MS) {
      callbackTokens.delete(key);
    }
  }
}

// ── HMAC verification ───────────────────────────────────────────────

async function verifySignature(
  payload: string,
  signature: string | null,
  secret: string
): Promise<boolean> {
  if (!signature) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const expected = `sha256=${Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  // Constant-time comparison to prevent timing attacks
  if (expected.length !== signature.length) return false;
  return Buffer.from(expected).equals(Buffer.from(signature));
}

// ── Database ────────────────────────────────────────────────────────

let db: Kysely<Database>;

// ── Webhook event mapping ───────────────────────────────────────────

function mapWebhookToEvent(
  eventType: string,
  payload: any
): { event: WorkflowEvent; issueNumber: number; repo: string } | null {
  const repo: string = payload.repository?.full_name || "";

  if (eventType === "issues" && payload.action === "labeled") {
    const label: string = payload.label?.name || "";
    const actor: string = payload.sender?.login || "";
    const issueNumber: number = payload.issue?.number;

    // Self-label loop prevention
    if (actor === BOT_USERNAME) {
      log.debug("Ignoring self-authored label event", { label, actor });
      return null;
    }

    if (label === "abandoned") {
      return { event: { type: "label_abandoned", triggeredBy: actor }, issueNumber, repo };
    }

    if (label === "plan-approved") {
      return { event: { type: "label_added", label, triggeredBy: actor }, issueNumber, repo };
    }

    if (label === "triage") {
      return { event: { type: "triage_label_added", triggeredBy: actor }, issueNumber, repo };
    }

    return null;
  }

  if (eventType === "issues" && payload.action === "opened") {
    const labels: string[] = (payload.issue?.labels || []).map((l: any) => l.name);
    const issueNumber: number = payload.issue?.number;
    const actor: string = payload.sender?.login || "";

    if (labels.includes("triage")) {
      // New parent issue with triage label -> will create workflow in TRIAGE state
      return null; // Handled specially below
    }

    return null;
  }

  if (eventType === "issue_comment" && payload.action === "created") {
    // Could be agent status updates or slash commands
    return null;
  }

  if (eventType === "pull_request" && payload.action === "opened") {
    const prNumber: number = payload.pull_request?.number;
    const isDraft: boolean = payload.pull_request?.draft || false;
    const body: string = payload.pull_request?.body || "";
    const actor: string = payload.sender?.login || "";

    // Look for linked issue in PR body (e.g., "Closes #11", "Part of #10")
    const issueMatch = body.match(/(?:closes|fixes|resolves|part of)\s+#(\d+)/i);
    if (!issueMatch) return null;
    const issueNumber = parseInt(issueMatch[1], 10);

    if (isDraft) {
      return { event: { type: "draft_pr_opened", triggeredBy: actor, prNumber }, issueNumber, repo };
    } else {
      // Non-draft PR: skip DRAFT_REVIEW, go straight to VERIFYING
      return { event: { type: "non_draft_pr_opened", triggeredBy: actor, prNumber }, issueNumber, repo };
    }
  }

  if (eventType === "pull_request" && payload.action === "ready_for_review") {
    const prNumber: number = payload.pull_request?.number;
    const body: string = payload.pull_request?.body || "";
    const actor: string = payload.sender?.login || "";

    const issueMatch = body.match(/(?:closes|fixes|resolves|part of)\s+#(\d+)/i);
    if (!issueMatch) return null;
    const issueNumber = parseInt(issueMatch[1], 10);

    return { event: { type: "pr_ready_for_review", triggeredBy: actor, prNumber }, issueNumber, repo };
  }

  if (eventType === "pull_request" && payload.action === "closed" && payload.pull_request?.merged) {
    const body: string = payload.pull_request?.body || "";
    const actor: string = payload.sender?.login || "";

    const issueMatch = body.match(/(?:closes|fixes|resolves|part of)\s+#(\d+)/i);
    if (!issueMatch) return null;
    const issueNumber = parseInt(issueMatch[1], 10);

    return { event: { type: "verified_and_shipped", triggeredBy: actor }, issueNumber, repo };
  }

  if (eventType === "pull_request_review" && payload.action === "submitted") {
    const state: string = payload.review?.state || "";
    const body: string = payload.pull_request?.body || "";
    const actor: string = payload.sender?.login || "";

    if (state !== "changes_requested") return null;

    const issueMatch = body.match(/(?:closes|fixes|resolves|part of)\s+#(\d+)/i);
    if (!issueMatch) return null;
    const issueNumber = parseInt(issueMatch[1], 10);

    return { event: { type: "changes_requested", triggeredBy: actor }, issueNumber, repo };
  }

  return null;
}

// ── Side effect execution ───────────────────────────────────────────

async function executeSideEffects(
  effects: SideEffect[],
  repo: string
): Promise<void> {
  const projectName = repoMap.get(repo)?.projectName;
  for (const effect of effects) {
    try {
      switch (effect.type) {
        case "spawn_agent": {
          const wf = await getWorkflowByIssue(db, effect.issueNumber, repo);
          if (wf) {
            await spawnAgent(db, {
              issueNumber: effect.issueNumber,
              repo,
              role: effect.role as AgentRole,
              workflowId: wf.id,
              projectName,
            }, { onFailed: onAgentFailed });
          }
          break;
        }
        case "add_label": {
          log.info(`Adding label '${effect.label}' to #${effect.issueNumber}`, {
            issueNumber: effect.issueNumber,
            label: effect.label,
          });
          await runGh(["issue", "edit", String(effect.issueNumber), "--repo", repo, "--add-label", effect.label]);
          break;
        }
        case "remove_label": {
          log.info(`Removing label '${effect.label}' from #${effect.issueNumber}`, {
            issueNumber: effect.issueNumber,
            label: effect.label,
          });
          await runGh(["issue", "edit", String(effect.issueNumber), "--repo", repo, "--remove-label", effect.label]);
          break;
        }
        case "post_comment": {
          log.info(`Posting comment on #${effect.issueNumber}`, { issueNumber: effect.issueNumber });
          await runGh(["issue", "comment", String(effect.issueNumber), "--repo", repo, "--body", effect.body]);
          break;
        }
        case "close_issue": {
          log.info(`Closing issue #${effect.issueNumber}`, { issueNumber: effect.issueNumber });
          await runGh(["issue", "close", String(effect.issueNumber), "--repo", repo]);
          break;
        }
        case "check_parent_completion": {
          await checkParentCompletion(effect.parentWorkflowId, repo);
          break;
        }
        case "abandon_children": {
          await abandonChildren(effect.parentWorkflowId, repo);
          break;
        }
        case "convert_pr_to_draft": {
          log.info(`Converting PR #${effect.prNumber} to draft`, { prNumber: effect.prNumber });
          await runGh(["pr", "ready", String(effect.prNumber), "--repo", repo, "--undo"]);
          break;
        }
        case "create_sub_issue": {
          log.info(`Creating sub-issue for parent #${effect.parentIssueNumber}`, {
            parentIssue: effect.parentIssueNumber,
          });
          await runGh([
            "issue", "create", "--repo", repo,
            "--title", effect.title,
            "--body", `${effect.body}\n\nPart of #${effect.parentIssueNumber}`,
            "--label", "planning",
          ]);
          break;
        }
        case "notify_human": {
          log.warn(`HUMAN NOTIFICATION: ${effect.message}`);
          break;
        }
      }
    } catch (err) {
      log.error(`Failed to execute side effect ${effect.type}: ${err}`, { effect: effect.type });
    }
  }
}

async function runGh(args: string[]): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    const errMsg = `gh ${args.join(" ")} → ${stderr.trim()}`;
    log.error(`gh command failed: ${errMsg}`);
    throw new Error(errMsg);
  }
  return output.trim();
}

// ── Parent completion check ─────────────────────────────────────────

async function checkParentCompletion(parentWorkflowId: string, repo: string): Promise<void> {
  // Wrap entire check in a transaction to prevent two concurrent sub-issue
  // completions from both triggering all_subs_done on the same parent
  const result = await withTransaction(db, async (trx) => {
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

  if (result) {
    log.info(`Parent ${parentWorkflowId}: ${result.transition.from} → ${result.transition.to}`, {
      trigger: "all_subs_done",
    });
    await executeSideEffects(result.sideEffects, repo);
  }
}

// ── Abandon children ────────────────────────────────────────────────

async function abandonChildren(parentWorkflowId: string, repo: string): Promise<void> {
  const subs = await getSubWorkflows(db, parentWorkflowId);
  for (const sub of subs) {
    if (TERMINAL_STATES.has(sub.state)) continue;

    const subWf: Workflow = {
      id: sub.id,
      issueNumber: sub.issue_number,
      state: sub.state,
      level: "sub",
      parentWorkflowId: sub.parent_workflow_id,
      draftReviewCycles: sub.draft_review_cycles,
    };
    const result = apply(subWf, { type: "label_abandoned", triggeredBy: "system" });
    if (result) {
      await withTransaction(db, async (trx) => {
        await updateWorkflowState(trx, sub.id, result.newState);
        await addTransition(trx, {
          id: `t-${crypto.randomUUID()}`,
          workflow_id: sub.id,
          from_state: result.transition.from,
          to_state: result.transition.to,
          event_type: "label_abandoned",
          triggered_by: "system",
          metadata: JSON.stringify({ reason: "parent abandoned" }),
          github_delivery_id: null,
        });
      });
      log.info(`Sub-issue ${sub.id} abandoned (parent abandoned)`, {
        subIssue: sub.issue_number,
      });
      // Execute label/comment effects but skip recursive check_parent_completion
      const safeEffects = result.sideEffects.filter((e) => e.type !== "check_parent_completion");
      await executeSideEffects(safeEffects, repo);
    }
  }
}

// ── Core webhook handler ────────────────────────────────────────────

async function handleWebhook(
  eventType: string,
  deliveryId: string,
  payload: any
): Promise<{ status: number; body: string }> {
  const repo: string = payload.repository?.full_name || "";

  // Dedup by delivery ID
  if (deliveryId && await hasDeliveryBeenProcessed(db, deliveryId)) {
    log.debug("Duplicate delivery, skipping", { deliveryId });
    return { status: 200, body: "duplicate" };
  }

  log.info(`Webhook: ${eventType}.${payload.action}`, {
    deliveryId,
    repo,
    sender: payload.sender?.login,
  });

  // Special handling: new issue with triage label creates parent workflow
  if (eventType === "issues" && payload.action === "opened") {
    const labels: string[] = (payload.issue?.labels || []).map((l: any) => l.name);
    if (labels.includes("triage")) {
      const issueNumber = payload.issue.number;
      const author = payload.sender?.login || "";
      const intent = payload.issue?.title || "";
      const wfId = `wf-${repo.replace("/", "-")}-${issueNumber}`;

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

      log.info(`Created parent workflow ${wfId} in TRIAGE`, { issueNumber });
      await executeSideEffects([
        { type: "spawn_agent", role: "triage", issueNumber },
      ], repo);
      return { status: 200, body: "parent workflow created" };
    }
  }

  // Special handling: new issue with planning label creates sub workflow
  if (eventType === "issues" && payload.action === "opened") {
    const labels: string[] = (payload.issue?.labels || []).map((l: any) => l.name);
    if (labels.includes("planning")) {
      const issueNumber = payload.issue.number;
      const author = payload.sender?.login || "";
      const intent = payload.issue?.title || "";
      const body: string = payload.issue?.body || "";
      const wfId = `wf-${repo.replace("/", "-")}-${issueNumber}`;

      // Extract parent reference from body
      const parentMatch = body.match(/Part of #(\d+)/i);
      const parentWorkflowId = parentMatch ? `wf-${repo.replace("/", "-")}-${parentMatch[1]}` : null;

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

      log.info(`Created sub workflow ${wfId} in PLANNING`, { issueNumber, parent: parentWorkflowId });
      return { status: 200, body: "sub workflow created" };
    }
  }

  // Handle triage label on existing issue (creates parent workflow if none exists)
  const mapped_pre = mapWebhookToEvent(eventType, payload);
  if (mapped_pre && mapped_pre.event.type === "triage_label_added") {
    const existingWf = await getWorkflowByIssue(db, mapped_pre.issueNumber, repo);
    if (!existingWf) {
      const author = payload.sender?.login || "";
      const intent = payload.issue?.title || "";
      const wfId = `wf-${repo.replace("/", "-")}-${mapped_pre.issueNumber}`;
      await upsertWorkflow(db, {
        id: wfId,
        issue_number: mapped_pre.issueNumber,
        repo,
        state: "TRIAGE",
        level: "parent",
        parent_workflow_id: null,
        author,
        intent,
      });
      log.info(`Created parent workflow ${wfId} in TRIAGE (label on existing issue)`, { issueNumber: mapped_pre.issueNumber });
      await executeSideEffects([{ type: "spawn_agent", role: "triage", issueNumber: mapped_pre.issueNumber }], repo);
      return { status: 200, body: "parent workflow created" };
    }
    if (existingWf && existingWf.state === "TRIAGE") {
      const agents = await getAgentSessions(db, existingWf.id);
      if (allAgentsDead(agents)) {
        // All agents failed, re-spawn
        log.info(`Re-spawning triage agent for stuck workflow ${existingWf.id}`, { issueNumber: mapped_pre.issueNumber });
        await executeSideEffects([{ type: "spawn_agent", role: "triage", issueNumber: mapped_pre.issueNumber }], repo);
        return { status: 200, body: "triage agent re-spawned" };
      }
      // Active agent exists, suppress the duplicate label event silently
      log.debug("Triage workflow already active, ignoring duplicate label event", { issueNumber: mapped_pre.issueNumber });
      return { status: 200, body: "triage already active" };
    }
    // Workflow exists but not in TRIAGE, fall through to normal processing
  }

  // Map webhook to state machine event
  const mapped = mapWebhookToEvent(eventType, payload);
  if (!mapped) {
    log.debug("No state machine event for this webhook", { eventType, action: payload.action });
    return { status: 200, body: "no-op" };
  }

  const { event, issueNumber } = mapped;

  // Load workflow
  let wfRow = await getWorkflowByIssue(db, issueNumber, repo);
  if (!wfRow) {
    // Backward compat: plan-approved label on an issue with no workflow
    if (event.type === "label_added" && (event as any).label === "plan-approved") {
      const author = payload.sender?.login || "";
      const intent = payload.issue?.title || "";
      const wfId = `wf-${repo.replace("/", "-")}-${issueNumber}`;

      await upsertWorkflow(db, {
        id: wfId,
        issue_number: issueNumber,
        repo,
        state: "REVIEW",
        level: "sub",
        parent_workflow_id: null,
        author,
        intent,
      });

      log.info(`Created ad-hoc workflow ${wfId} in REVIEW for backward compat`, { issueNumber });
      wfRow = await getWorkflowByIssue(db, issueNumber, repo);
    }
  }

  if (!wfRow) {
    log.warn("No workflow found for issue", { issueNumber, event: event.type });
    return { status: 200, body: "no workflow" };
  }

  const workflow: Workflow = {
    id: wfRow.id,
    issueNumber: wfRow.issue_number,
    state: wfRow.state,
    level: wfRow.level as "parent" | "sub",
    parentWorkflowId: wfRow.parent_workflow_id,
    draftReviewCycles: wfRow.draft_review_cycles,
  };

  // Apply state machine
  const result = apply(workflow, event);

  if (!result) {
    const msg = `Cannot apply '${event.type}' — issue #${issueNumber} is in ${workflow.state} state.`;
    log.warn(`REJECTED: ${msg}`, { issueNumber, state: workflow.state, event: event.type });
    // Post a comment explaining the rejection
    await executeSideEffects([
      { type: "post_comment", issueNumber, body: `Zapbot: ${msg}` },
    ], repo);
    return { status: 200, body: "rejected" };
  }

  // Apply transition atomically
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

  log.info(`${workflow.id}: ${result.transition.from} → ${result.transition.to}`, {
    trigger: event.type,
    by: event.triggeredBy,
  });

  // Execute side effects
  await executeSideEffects(result.sideEffects, repo);

  return { status: 200, body: `${result.transition.from} → ${result.transition.to}` };
}

// ── AO proxy ────────────────────────────────────────────────────────

async function proxyToAO(req: Request, path: string): Promise<Response> {
  try {
    const url = `${AO_URL}${path}`;
    const resp = await fetch(url, {
      method: req.method,
      headers: req.headers,
      body: req.method !== "GET" ? await req.text() : undefined,
    });
    return new Response(resp.body, { status: resp.status, headers: resp.headers });
  } catch (err) {
    return new Response(`AO proxy error: ${err}`, { status: 502 });
  }
}

// ── HTTP server ─────────────────────────────────────────────────────

// ── Startup recovery ───────────────────────────────────────────────

async function recoverStuckWorkflows(): Promise<void> {
  const active = await db.selectFrom("workflows")
    .selectAll()
    .where("state", "not in", ["COMPLETED", "ABANDONED", "DONE"])
    .execute();

  if (active.length === 0) {
    log.info("Recovery: no active workflows found");
    return;
  }

  log.info(`Recovery: scanning ${active.length} active workflow(s)`);

  const agentStates = new Set(["TRIAGE", "IMPLEMENTING", "VERIFYING"]);

  for (const wf of active) {
    const agents = await getAgentSessions(db, wf.id);

    if (agentStates.has(wf.state) && allAgentsDead(agents)) {
      const role: AgentRole = wf.state === "TRIAGE" ? "triage"
        : wf.state === "VERIFYING" ? "qe"
        : "implementer";
      log.warn(`Recovery: ${wf.id} stuck in ${wf.state} with all agents dead, re-spawning ${role}`, {
        workflow: wf.id, state: wf.state, role,
      });
      await executeSideEffects([
        { type: "spawn_agent", role, issueNumber: wf.issue_number },
        { type: "post_comment", issueNumber: wf.issue_number,
          body: `Zapbot: Bridge restarted. Re-spawning ${role} agent for stuck workflow.` },
      ], wf.repo);
    } else {
      const zombies = agents.filter((a) => a.status === "running" || a.status === "spawning");
      if (zombies.length > 0) {
        log.info(`Recovery: ${wf.id} has ${zombies.length} agent(s) still marked running, will check on next heartbeat`, {
          workflow: wf.id, state: wf.state,
        });
      }
    }
  }
}

async function main() {
  db = await initDatabase();

  startHeartbeatChecker(db, onAgentFailed);

  await recoverStuckWorkflows();

  log.info(`Webhook bridge starting on port ${PORT}`);

  const server = Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);
      const pathname = url.pathname;

      // Health check
      if (pathname === "/healthz") {
        return new Response("ok", { status: 200 });
      }

      // GitHub webhook
      if (pathname === "/api/webhooks/github" && req.method === "POST") {
        const body = await req.text();
        const signature = req.headers.get("x-hub-signature-256");
        const eventType = req.headers.get("x-github-event") || "";
        const deliveryId = req.headers.get("x-github-delivery") || "";

        // Parse payload first to extract repo for per-repo secret lookup
        let payload: any;
        try {
          payload = JSON.parse(body);
        } catch {
          return new Response("invalid JSON", { status: 400 });
        }

        const repoFullName: string = payload.repository?.full_name || "";

        // Reject webhooks from unconfigured repos (only when config is loaded)
        if (repoMap.size > 0 && repoFullName && !repoMap.has(repoFullName)) {
          log.warn("Webhook from unconfigured repo, rejecting", { repo: repoFullName, deliveryId });
          return new Response(`repo '${repoFullName}' is not configured`, { status: 403 });
        }

        // Per-repo HMAC verification with shared secret fallback
        const secret = resolveWebhookSecret(repoFullName, repoMap, WEBHOOK_SECRET!);
        if (!(await verifySignature(body, signature, secret))) {
          return new Response("invalid signature", { status: 401 });
        }

        const result = await handleWebhook(eventType, deliveryId, payload);
        return new Response(result.body, { status: result.status });
      }

      // Workflow state API
      if (pathname.match(/^\/api\/workflows\/(\d+)$/) && req.method === "GET") {
        const auth = req.headers.get("authorization");
        if (auth !== `Bearer ${WEBHOOK_SECRET}`) {
          return new Response("unauthorized", { status: 401 });
        }
        const issueNumber = parseInt(pathname.split("/").pop()!, 10);
        const repo = url.searchParams.get("repo") || "";
        const wf = await getWorkflowByIssue(db, issueNumber, repo);
        if (!wf) return new Response("not found", { status: 404 });

        const subs = wf.level === "parent" ? await getSubWorkflows(db, wf.id) : [];
        const agents = await getAgentSessions(db, wf.id);

        return Response.json({ workflow: wf, subWorkflows: subs, agents });
      }

      // Workflow history API
      if (pathname.match(/^\/api\/workflows\/(\d+)\/history$/) && req.method === "GET") {
        const auth = req.headers.get("authorization");
        if (auth !== `Bearer ${WEBHOOK_SECRET}`) {
          return new Response("unauthorized", { status: 401 });
        }
        const issueNumber = parseInt(pathname.split("/")[3], 10);
        const repo = url.searchParams.get("repo") || "";
        const wf = await getWorkflowByIssue(db, issueNumber, repo);
        if (!wf) return new Response("not found", { status: 404 });

        const history = await getTransitionHistory(db, wf.id);
        return Response.json({ history });
      }

      // Agent heartbeat
      if (pathname.match(/^\/api\/agents\/[\w-]+\/heartbeat$/) && req.method === "POST") {
        const agentId = pathname.split("/")[3];
        const auth = req.headers.get("authorization");
        if (auth !== `Bearer ${WEBHOOK_SECRET}`) {
          return new Response("unauthorized", { status: 401 });
        }
        const session = await getAgentSession(db, agentId);
        if (!session) return new Response("not found", { status: 404 });
        await updateAgentHeartbeat(db, agentId);
        return new Response("ok", { status: 200 });
      }

      // Agent complete
      if (pathname.match(/^\/api\/agents\/[\w-]+\/complete$/) && req.method === "POST") {
        const agentId = pathname.split("/")[3];
        const auth = req.headers.get("authorization");
        if (auth !== `Bearer ${WEBHOOK_SECRET}`) {
          return new Response("unauthorized", { status: 401 });
        }
        const session = await getAgentSession(db, agentId);
        if (!session) return new Response("not found", { status: 404 });

        const body = await req.json().catch(() => ({}));
        await updateAgentStatus(db, agentId, body.status || "completed", body.prNumber);
        log.info(`Agent ${agentId} completed`, { agentId, status: body.status });
        return new Response("ok", { status: 200 });
      }

      // Plannotator callback
      if (pathname.match(/^\/api\/callbacks\/plannotator\/(\d+)$/) && req.method === "POST") {
        // CORS headers for browser-based plannotator callbacks
        const corsHeaders = {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        };
        if (req.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: corsHeaders });
        }

        const issueNumber = parseInt(pathname.split("/").pop()!, 10);
        const body = await req.json().catch(() => ({}));

        // Resolve repo: token store first, then request body, then env var fallback
        const stored = body.token ? callbackTokens.get(body.token) : undefined;
        const repo = stored?.repo || body.repo || process.env.ZAPBOT_REPO || "";

        log.info(`Plannotator callback for #${issueNumber}`, { issueNumber, repo });

        // Handle plan_published event from zapbot-publish.sh
        if (body.event === "plan_published") {
          const wf = await getWorkflowByIssue(db, issueNumber, repo);
          if (wf && wf.state === "PLANNING") {
            const mapped: WorkflowEvent = { type: "plan_published", triggeredBy: body.author || "author" };
            const workflow: Workflow = {
              id: wf.id,
              issueNumber: wf.issue_number,
              state: wf.state,
              level: wf.level as "parent" | "sub",
              parentWorkflowId: wf.parent_workflow_id,
              draftReviewCycles: wf.draft_review_cycles,
            };
            const result = apply(workflow, mapped);
            if (result) {
              await withTransaction(db, async (trx) => {
                await updateWorkflowState(trx, wf.id, result.newState);
                await addTransition(trx, {
                  id: `t-${crypto.randomUUID()}`,
                  workflow_id: wf.id,
                  from_state: result.transition.from,
                  to_state: result.transition.to,
                  event_type: "plan_published",
                  triggered_by: body.author || "author",
                  metadata: null,
                  github_delivery_id: null,
                });
              });
              await executeSideEffects(result.sideEffects, repo);
              log.info(`Plan published: ${wf.id} PLANNING → REVIEW`, { issueNumber });
            }
          }
          const resp = new Response("ok", { status: 200 });
          for (const [k, v] of Object.entries(corsHeaders)) resp.headers.set(k, v);
          return resp;
        }

        // Check if this has "revise" annotations
        const hasRevisions = body.annotations?.some((a: any) => a.type === "revise");
        if (hasRevisions) {
          const wf = await getWorkflowByIssue(db, issueNumber, repo);
          if (wf && wf.state === "REVIEW") {
            const mapped: WorkflowEvent = { type: "annotation_feedback", triggeredBy: body.reviewer || "reviewer" };
            const workflow: Workflow = {
              id: wf.id,
              issueNumber: wf.issue_number,
              state: wf.state,
              level: wf.level as "parent" | "sub",
              parentWorkflowId: wf.parent_workflow_id,
              draftReviewCycles: wf.draft_review_cycles,
            };
            const result = apply(workflow, mapped);
            if (result) {
              await withTransaction(db, async (trx) => {
                await updateWorkflowState(trx, wf.id, result.newState);
                await addTransition(trx, {
                  id: `t-${crypto.randomUUID()}`,
                  workflow_id: wf.id,
                  from_state: result.transition.from,
                  to_state: result.transition.to,
                  event_type: "annotation_feedback",
                  triggered_by: body.reviewer || "reviewer",
                  metadata: JSON.stringify(body.annotations),
                  github_delivery_id: null,
                });
              });
              await executeSideEffects(result.sideEffects, repo);
            }
          }
        }

        const resp = new Response("ok", { status: 200 });
        for (const [k, v] of Object.entries(corsHeaders)) resp.headers.set(k, v);
        return resp;
      }

      // Token registration for plannotator callbacks
      if (pathname === "/api/tokens" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const { token, issueNumber, repo } = body;
        if (!token || typeof token !== "string" || issueNumber == null || typeof issueNumber !== "number") {
          return new Response("missing or invalid token/issueNumber", { status: 400 });
        }
        pruneExpiredTokens();
        callbackTokens.set(token, {
          issueNumber,
          repo: repo || process.env.ZAPBOT_REPO || "",
          createdAt: Date.now(),
        });
        log.info(`Registered callback token for #${issueNumber}`, {
          issueNumber,
          repo: repo || process.env.ZAPBOT_REPO || "",
        });
        return Response.json({ ok: true });
      }

      return new Response("not found", { status: 404 });
    },
  });

  log.info(`Webhook bridge listening on http://localhost:${PORT}`);

  // Periodic token cleanup (every hour)
  const tokenCleanupInterval = setInterval(pruneExpiredTokens, 60 * 60 * 1000);

  // Graceful shutdown
  process.on("SIGINT", async () => {
    log.info("Shutting down...");
    stopHeartbeatChecker();
    cancelPendingRetries();
    clearInterval(tokenCleanupInterval);
    server.stop();
    await db.destroy();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    log.info("Shutting down...");
    stopHeartbeatChecker();
    cancelPendingRetries();
    clearInterval(tokenCleanupInterval);
    server.stop();
    await db.destroy();
    process.exit(0);
  });
}

main().catch((err) => {
  log.error(`Fatal: ${err}`);
  process.exit(1);
});
