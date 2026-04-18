import { Kysely } from "kysely";
import { initDatabase, type Database, serializeDeps, deserializeDeps } from "../src/store/database.js";
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
import { LABEL_TO_STATE, TERMINAL_STATES, STATE_TO_LABEL, SubState } from "../src/state-machine/states.js";
import type { WorkflowEvent } from "../src/state-machine/events.js";
import type { SideEffect } from "../src/state-machine/effects.js";
import type { Workflow } from "../src/state-machine/transitions.js";
import { spawnAgent, cancelPendingRetries, type AgentRole, type AgentFailureHandler } from "../src/agents/spawner.js";
import { startHeartbeatChecker, stopHeartbeatChecker } from "../src/agents/heartbeat.js";
import { cleanupWorkflowSessions, cleanupStaleSessions } from "../src/agents/cleanup.js";
import { startProgressPoller } from "../src/agents/progress.js";
import type { WorkflowTable } from "../src/store/database.js";
import { createLogger } from "../src/logger.js";
import { loadConfig, resolveWebhookSecret, type RepoMap } from "../src/config/loader.js";
import { reloadConfigFromDisk } from "../src/config/reload.js";
import { createGitHubClient, getInstallationToken } from "../src/github/client.js";
import {
  handleInstallationTokenRequest,
  type InstallationTokenStatus,
} from "../src/http/routes/installation-token.js";
import { makeWorkflowId } from "../src/workflow-id.js";
import { errorResponse } from "../src/http/error-response.js";
import { verifySignature } from "../src/http/verify-signature.js";
import { setupGateway } from "../src/gateway/client.js";

// Prevent crashes from unhandled async errors
process.on("unhandledRejection", (err) => {
  console.error("[bridge] Unhandled rejection (non-fatal):", err instanceof Error ? err.message : err);
});

const log = createLogger("bridge");
const gh = createGitHubClient();

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
    body: `All agents for this workflow have failed (state: \`${wf.state}\`). Remove and re-add the triggering label to retry, or add \`abandoned\` to stop.`,
  }], wf.repo);
}

// ── Configuration ───────────────────────────────────────────────────

const PORT = parseInt(process.env.ZAPBOT_PORT || "3000", 10);
let WEBHOOK_SECRET = process.env.ZAPBOT_API_KEY;
if (!WEBHOOK_SECRET) {
  console.error("[bridge] ZAPBOT_API_KEY is required. Set it in .env or export it.");
  process.exit(1);
}
const BOT_USERNAME = process.env.ZAPBOT_BOT_USERNAME || "zapbot[bot]";

/**
 * Check if an issue is assigned to the bot. Returns true if the bot username
 * appears in the issue's assignees list. This gates all workflow creation
 * and state machine transitions so the bot only works on issues explicitly
 * assigned to it.
 */
function isAssignedToBot(payload: any): boolean {
  const assignees: Array<{ login: string }> = payload.issue?.assignees || [];
  return assignees.some((a) => a.login === BOT_USERNAME);
}

/** Map an issue label to the agent role it implies. */
function labelToRole(labels: string[]): "triage" | "planner" | "implementer" | "investigator" | "qe" | null {
  if (labels.includes("implementing")) return "implementer";
  if (labels.includes("investigating")) return "investigator";
  if (labels.includes("verifying")) return "qe";
  if (labels.includes("planning") || labels.includes("review")) return "planner";
  if (labels.includes("triage")) return "triage";
  return null;
}

/** Map a workflow state to the agent role that should be working on it. */
function stateToRole(state: string): "triage" | "planner" | "implementer" | "investigator" | "qe" | null {
  switch (state) {
    case "TRIAGE": return "triage";
    case "PLANNING": case "REVIEW": return "planner";
    case "IMPLEMENTING": case "DRAFT_REVIEW": return "implementer";
    case "INVESTIGATING": return "investigator";
    case "VERIFYING": return "qe";
    default: return null;
  }
}
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
} as const;
const AO_URL = process.env.AO_URL || "http://localhost:3001";

// Multi-repo config: loaded from agent-orchestrator.yaml or ZAPBOT_REPO env var
let { repoMap } = loadConfig(process.env.ZAPBOT_CONFIG || undefined);

// ── SIGHUP config reload ───────────────────────────────────────────
function reloadConfig(): void {
  const envPath = process.env.ZAPBOT_CONFIG?.replace(/agent-orchestrator\.yaml$/, ".env");
  const result = reloadConfigFromDisk(envPath, process.env.ZAPBOT_CONFIG || undefined, WEBHOOK_SECRET);
  if (result) {
    repoMap = result.config.repoMap;
    WEBHOOK_SECRET = result.config.webhookSecret;
  }
}

process.on("SIGHUP", () => {
  log.info("SIGHUP received, reloading config...");
  reloadConfig();
});

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

// ── Database ────────────────────────────────────────────────────────

let db: Kysely<Database>;

import { mapWebhookToEvent, parseDependencies } from "../src/webhook/mapper.js";

// ── Side effect execution ───────────────────────────────────────────

async function executeSideEffects(
  effects: SideEffect[],
  repo: string
): Promise<void> {
  const projectName = repoMap.get(repo)?.projectName;
  const failedEffects: SideEffect[] = [];
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
          await gh.addLabel(repo, effect.issueNumber, effect.label);
          break;
        }
        case "remove_label": {
          log.info(`Removing label '${effect.label}' from #${effect.issueNumber}`, {
            issueNumber: effect.issueNumber,
            label: effect.label,
          });
          await gh.removeLabel(repo, effect.issueNumber, effect.label);
          break;
        }
        case "post_comment": {
          log.info(`Posting comment on #${effect.issueNumber}`, { issueNumber: effect.issueNumber });
          await gh.postComment(repo, effect.issueNumber, effect.body);
          break;
        }
        case "close_issue": {
          log.info(`Closing issue #${effect.issueNumber}`, { issueNumber: effect.issueNumber });
          await gh.closeIssue(repo, effect.issueNumber);
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
          await gh.convertPrToDraft(repo, effect.prNumber);
          break;
        }
        case "create_sub_issue": {
          log.info(`Creating sub-issue for parent #${effect.parentIssueNumber}`, {
            parentIssue: effect.parentIssueNumber,
          });
          await gh.createIssue(
            repo,
            effect.title,
            `${effect.body}\n\nPart of #${effect.parentIssueNumber}`,
            ["planning"],
          );
          break;
        }
        case "notify_human": {
          log.warn(`HUMAN NOTIFICATION: ${effect.message}`);
          break;
        }
      }
    } catch (err) {
      // Retry once for GitHub API effects
      const retryable = ["add_label", "remove_label", "post_comment", "close_issue", "convert_pr_to_draft", "create_sub_issue"];
      if (retryable.includes(effect.type)) {
        log.warn(`Effect ${effect.type} failed, retrying in 2s: ${err}`, { effect: effect.type });
        await new Promise((r) => setTimeout(r, 2000));
        try {
          // Re-execute the same effect
          switch (effect.type) {
            case "add_label": await gh.addLabel(repo, effect.issueNumber, effect.label); break;
            case "remove_label": await gh.removeLabel(repo, effect.issueNumber, effect.label); break;
            case "post_comment": await gh.postComment(repo, effect.issueNumber, effect.body); break;
            case "close_issue": await gh.closeIssue(repo, effect.issueNumber); break;
            case "convert_pr_to_draft": await gh.convertPrToDraft(repo, effect.prNumber); break;
            case "create_sub_issue": await gh.createIssue(repo, effect.title, `${effect.body}\n\nPart of #${effect.parentIssueNumber}`, ["planning"]); break;
          }
          log.info(`Effect ${effect.type} succeeded on retry`);
        } catch (retryErr) {
          log.error(`Effect ${effect.type} failed after retry: ${retryErr}`, { effect: effect.type });
          failedEffects.push(effect);
        }
      } else {
        log.error(`Non-retryable effect ${effect.type} failed: ${err}`, { effect: effect.type });
      }
    }
  }

  // Post reconciliation comment if any retryable effects failed
  if (failedEffects.length > 0) {
    const issueNumbers = new Set(failedEffects.filter((e) => "issueNumber" in e).map((e) => (e as any).issueNumber));
    for (const issueNum of issueNumbers) {
      const failed = failedEffects.filter((e) => "issueNumber" in e && (e as any).issueNumber === issueNum);
      const msg = [
        "Some side effects failed after retry. The workflow state in the database may differ from GitHub.",
        "",
        "**Failed effects:**",
        ...failed.map((f) => `- \`${f.type}\``),
        "",
        "Check the bridge logs for details.",
      ].join("\n");
      try { await gh.postComment(repo, issueNum, msg); } catch (err) { log.debug(`postComment best-effort failed: ${err}`); }
    }
  }
}

// ── Dependency checking and unblocking ─────────────────────────────

/** Returns issue numbers that are not yet in a terminal state. Uses an in-memory subs list when available to avoid redundant DB queries. */
function findBlockingDeps(deps: number[], repo: string, siblingWorkflows?: { issue_number: number; state: string }[]): number[] {
  const blocking: number[] = [];
  for (const depIssue of deps) {
    // Check in-memory siblings first (avoids DB round-trip)
    const sibling = siblingWorkflows?.find((s) => s.issue_number === depIssue);
    if (sibling) {
      if (!TERMINAL_STATES.has(sibling.state)) blocking.push(depIssue);
    } else {
      // Dependency is outside the parent (rare) — can't check without DB query, assume blocking
      blocking.push(depIssue);
    }
  }
  return blocking;
}

async function findBlockingDepsAsync(deps: number[], repo: string): Promise<number[]> {
  const results = await Promise.all(deps.map(async (depIssue) => {
    const depWf = await getWorkflow(db, makeWorkflowId(repo, depIssue));
    return (!depWf || !TERMINAL_STATES.has(depWf.state)) ? depIssue : null;
  }));
  return results.filter((n): n is number => n !== null);
}

/** When a sub-issue completes, check if any siblings were waiting on it. */
async function unblockDependents(completedIssueNumber: number, parentWorkflowId: string, repo: string): Promise<void> {
  const subs = await getSubWorkflows(db, parentWorkflowId);
  // Only check PLANNING siblings that have dependencies referencing the completed issue
  const planningSubsWithDeps = subs.filter((s) => {
    if (s.state !== SubState.PLANNING) return false;
    const deps = deserializeDeps(s.dependencies);
    return deps.includes(completedIssueNumber);
  });
  if (planningSubsWithDeps.length === 0) return;

  for (const sub of planningSubsWithDeps) {
    const deps = deserializeDeps(sub.dependencies);
    const blocking = findBlockingDeps(deps, repo, subs);

    if (blocking.length === 0) {
      log.info(`Unblocking #${sub.issue_number} — all dependencies satisfied`, {
        issueNumber: sub.issue_number, completedDep: completedIssueNumber,
      });
      await executeSideEffects([
        { type: "spawn_agent", role: "planner", issueNumber: sub.issue_number },
        { type: "post_comment", issueNumber: sub.issue_number,
          body: `Dependency #${completedIssueNumber} completed. All dependencies satisfied. Spawning planner agent.` },
      ], repo);
    } else {
      log.debug(`#${sub.issue_number} still blocked on ${blocking.map((n) => `#${n}`).join(", ")}`, {
        issueNumber: sub.issue_number,
      });
    }
  }
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

    // GC: clean up parent workflow sessions when it reaches terminal state
    if (TERMINAL_STATES.has(result.newState)) {
      cleanupWorkflowSessions(db, parentWorkflowId).catch((err) =>
        log.warn(`Parent completion cleanup failed for ${parentWorkflowId}: ${err}`)
      );
    }
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

// ── Triage workflow helper ──────────────────────────────────────

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
  log.info(`Created parent workflow ${wfId} in TRIAGE`, { issueNumber });
  await executeSideEffects([
    { type: "spawn_agent", role: "triage", issueNumber },
    { type: "post_comment", issueNumber, body: "Workflow started. Spawning triage agent to analyze this issue and determine the best approach." },
  ], repo);
}

// ── Mention command handler ─────────────────────────────────────────

const WRITE_PERMISSIONS = new Set(["write", "maintain", "admin"]);

async function handleMentionCommand(
  event: Extract<import("../src/state-machine/events.js").WorkflowEvent, { type: "mention_command" }>,
  repo: string,
  deliveryId: string
): Promise<{ status: number; body: string }> {
  const { command, issueNumber, triggeredBy, commentId } = event;

  // Eyes emoji reaction for immediate feedback
  try {
    await gh.addReaction(repo, commentId, "eyes");
  } catch (err) {
    log.warn(`Failed to add eyes reaction to comment ${commentId}: ${err}`);
  }

  // Permission check: only users with write access can trigger commands
  try {
    const permission = await gh.getUserPermission(repo, triggeredBy);
    if (!WRITE_PERMISSIONS.has(permission)) {
      await executeSideEffects([{
        type: "post_comment", issueNumber,
        body: `Sorry @${triggeredBy}, you need write access to this repo to use commands.`,
      }], repo);
      return { status: 200, body: "insufficient permissions" };
    }
  } catch (err) {
    log.error(`Permission check failed for ${triggeredBy}, rejecting command: ${err}`);
    await executeSideEffects([{
      type: "post_comment", issueNumber,
      body: `Sorry @${triggeredBy}, I couldn't verify your permissions right now. Please try again in a moment.`,
    }], repo);
    return { status: 200, body: "permission check failed" };
  }

  const cmdLower = command.toLowerCase().trim();

  // ── plan this / triage this ──────────────────────────────────────
  if (cmdLower === "plan this" || cmdLower === "triage this") {
    const existingWf = await getWorkflowByIssue(db, issueNumber, repo);
    if (existingWf) {
      await executeSideEffects([{
        type: "post_comment", issueNumber,
        body: `A workflow already exists for this issue (state: \`${existingWf.state}\`). Use \`@${BOT_USERNAME} status\` to check progress.`,
      }], repo);
      return { status: 200, body: "workflow already exists" };
    }

    // Auto-assign bot to the issue so downstream events are processed
    try {
      await gh.assignIssue(repo, issueNumber, [BOT_USERNAME]);
    } catch (err) {
      log.warn(`Failed to auto-assign bot to #${issueNumber}: ${err}`);
    }

    const intent = `Triggered by @${triggeredBy} via mention`;
    await createTriageWorkflow(repo, issueNumber, triggeredBy, intent, deliveryId);

    // Log mention to transitions for audit trail
    const wfId = makeWorkflowId(repo, issueNumber);
    await addTransition(db, {
      id: `t-${crypto.randomUUID()}`,
      workflow_id: wfId,
      from_state: "TRIAGE",
      to_state: "TRIAGE",
      event_type: `mention:${cmdLower.replace(/\s+/g, "-")}`,
      triggered_by: triggeredBy,
      metadata: JSON.stringify({ command, commentId }),
      github_delivery_id: deliveryId,
    });

    return { status: 200, body: "workflow created via mention" };
  }

  // ── investigate this ──────────────────────────────────────────────
  if (cmdLower === "investigate this" || cmdLower === "investigate") {
    const wfRow = await getWorkflowByIssue(db, issueNumber, repo);
    if (!wfRow) {
      // No workflow needed for investigation — create one and spawn investigator
      try {
        await gh.assignIssue(repo, issueNumber, [BOT_USERNAME]);
      } catch (err) {
        log.warn(`Failed to auto-assign bot to #${issueNumber}: ${err}`);
      }
      const intent = `Investigation triggered by @${triggeredBy}`;
      const wfId = makeWorkflowId(repo, issueNumber);
      await upsertWorkflow(db, {
        id: wfId,
        issue_number: issueNumber,
        repo,
        state: "INVESTIGATING",
        level: "sub",
        parent_workflow_id: null,
        author: triggeredBy,
        intent,
      });
      await addTransition(db, {
        id: `t-${crypto.randomUUID()}`,
        workflow_id: wfId,
        from_state: "NEW",
        to_state: "INVESTIGATING",
        event_type: "mention:investigate",
        triggered_by: triggeredBy,
        metadata: JSON.stringify({ command, commentId }),
        github_delivery_id: deliveryId,
      });
      await executeSideEffects([
        { type: "remove_label", issueNumber, label: "planning" },
        { type: "add_label", issueNumber, label: "investigating" },
        { type: "spawn_agent", role: "investigator", issueNumber },
        { type: "post_comment", issueNumber,
          body: `Spawning **investigator** agent per @${triggeredBy}'s request.` },
      ], repo);
      return { status: 200, body: "investigator spawned (new workflow)" };
    }

    log.info(`Spawning investigator for #${issueNumber} via mention`, { issueNumber });

    // Move to INVESTIGATING if not already there
    const labelEffects: Array<Record<string, any>> = [];
    if (wfRow.state !== "INVESTIGATING") {
      await updateWorkflowState(db, wfRow.id, "INVESTIGATING");
      labelEffects.push({ type: "add_label", issueNumber, label: "investigating" });
    }
    await executeSideEffects([
      ...labelEffects,
      { type: "spawn_agent", role: "investigator", issueNumber },
      { type: "post_comment", issueNumber,
        body: `Spawning **investigator** agent per @${triggeredBy}'s request.` },
    ], repo);

    await addTransition(db, {
      id: `t-${crypto.randomUUID()}`,
      workflow_id: wfRow.id,
      from_state: wfRow.state,
      to_state: "INVESTIGATING",
      event_type: "mention:investigate",
      triggered_by: triggeredBy,
      metadata: JSON.stringify({ command, commentId }),
      github_delivery_id: deliveryId,
    });

    return { status: 200, body: "investigator spawned via mention" };
  }

  // ── implement this ────────────────────────────────────────────────
  if (cmdLower === "implement this" || cmdLower === "implement") {
    let wfRow = await getWorkflowByIssue(db, issueNumber, repo);
    if (!wfRow) {
      // Create workflow on the fly and spawn implementer
      try {
        await gh.assignIssue(repo, issueNumber, [BOT_USERNAME]);
      } catch (err) {
        log.warn(`Failed to auto-assign bot to #${issueNumber}: ${err}`);
      }
      const intent = `Implementation triggered by @${triggeredBy}`;
      const wfId = makeWorkflowId(repo, issueNumber);
      await upsertWorkflow(db, {
        id: wfId,
        issue_number: issueNumber,
        repo,
        state: "IMPLEMENTING",
        level: "sub",
        parent_workflow_id: null,
        author: triggeredBy,
        intent,
      });
      await addTransition(db, {
        id: `t-${crypto.randomUUID()}`,
        workflow_id: wfId,
        from_state: "NEW",
        to_state: "IMPLEMENTING",
        event_type: "mention:implement",
        triggered_by: triggeredBy,
        metadata: JSON.stringify({ command, commentId }),
        github_delivery_id: deliveryId,
      });
      await executeSideEffects([
        { type: "remove_label", issueNumber, label: "planning" },
        { type: "add_label", issueNumber, label: "implementing" },
        { type: "spawn_agent", role: "implementer", issueNumber },
        { type: "post_comment", issueNumber,
          body: `Spawning **implementer** agent per @${triggeredBy}'s request.` },
      ], repo);
      return { status: 200, body: "implementer spawned (new workflow)" };
    }

    log.info(`Spawning implementer for #${issueNumber} via mention`, { issueNumber });

    // Move to IMPLEMENTING if not already there
    const labelEffects: Array<Record<string, any>> = [];
    if (wfRow.state !== SubState.IMPLEMENTING && wfRow.state !== SubState.DRAFT_REVIEW) {
      await updateWorkflowState(db, wfRow.id, SubState.IMPLEMENTING);
      labelEffects.push({ type: "add_label", issueNumber, label: "implementing" });
    }
    await executeSideEffects([
      ...labelEffects,
      { type: "spawn_agent", role: "implementer", issueNumber },
      { type: "post_comment", issueNumber,
        body: `Spawning **implementer** agent per @${triggeredBy}'s request.` },
    ], repo);

    await addTransition(db, {
      id: `t-${crypto.randomUUID()}`,
      workflow_id: wfRow.id,
      from_state: wfRow.state,
      to_state: SubState.IMPLEMENTING,
      event_type: "mention:implement",
      triggered_by: triggeredBy,
      metadata: JSON.stringify({ command, commentId }),
      github_delivery_id: deliveryId,
    });

    return { status: 200, body: "implementer spawned via mention" };
  }

  // ── verify this ──────────────────────────────────────────────────
  if (cmdLower === "verify this" || cmdLower === "verify") {
    let wfRow = await getWorkflowByIssue(db, issueNumber, repo);
    if (!wfRow) {
      // Create workflow on the fly and spawn QE
      try {
        await gh.assignIssue(repo, issueNumber, [BOT_USERNAME]);
      } catch (err) {
        log.warn(`Failed to auto-assign bot to #${issueNumber}: ${err}`);
      }
      const intent = `Verification triggered by @${triggeredBy}`;
      const wfId = makeWorkflowId(repo, issueNumber);
      await upsertWorkflow(db, {
        id: wfId,
        issue_number: issueNumber,
        repo,
        state: "VERIFYING",
        level: "sub",
        parent_workflow_id: null,
        author: triggeredBy,
        intent,
      });
      await addTransition(db, {
        id: `t-${crypto.randomUUID()}`,
        workflow_id: wfId,
        from_state: "NEW",
        to_state: "VERIFYING",
        event_type: "mention:verify",
        triggered_by: triggeredBy,
        metadata: JSON.stringify({ command, commentId }),
        github_delivery_id: deliveryId,
      });
      await executeSideEffects([
        { type: "remove_label", issueNumber, label: "planning" },
        { type: "add_label", issueNumber, label: "verifying" },
        { type: "spawn_agent", role: "qe", issueNumber },
        { type: "post_comment", issueNumber,
          body: `Spawning **QE** agent per @${triggeredBy}'s request.` },
      ], repo);
      return { status: 200, body: "qe spawned (new workflow)" };
    }

    log.info(`Spawning QE for #${issueNumber} via mention`, { issueNumber });

    const verifyLabelEffects: Array<Record<string, any>> = [];
    if (wfRow.state !== SubState.VERIFYING) {
      await updateWorkflowState(db, wfRow.id, SubState.VERIFYING);
      verifyLabelEffects.push({ type: "add_label", issueNumber, label: "verifying" });
    }
    await executeSideEffects([
      ...verifyLabelEffects,
      { type: "spawn_agent", role: "qe", issueNumber },
      { type: "post_comment", issueNumber,
        body: `Spawning **QE** agent per @${triggeredBy}'s request.` },
    ], repo);

    await addTransition(db, {
      id: `t-${crypto.randomUUID()}`,
      workflow_id: wfRow.id,
      from_state: wfRow.state,
      to_state: SubState.VERIFYING,
      event_type: "mention:verify",
      triggered_by: triggeredBy,
      metadata: JSON.stringify({ command, commentId }),
      github_delivery_id: deliveryId,
    });

    return { status: 200, body: "qe spawned via mention" };
  }

  // ── status ───────────────────────────────────────────────────────
  if (cmdLower === "status") {
    const wfRow = await getWorkflowByIssue(db, issueNumber, repo);
    if (!wfRow) {
      await executeSideEffects([{
        type: "post_comment", issueNumber,
        body: "No workflow found for this issue. Use `@" + BOT_USERNAME + " plan this` to start one.",
      }], repo);
      return { status: 200, body: "no workflow" };
    }

    const agents = await getAgentSessions(db, wfRow.id);
    const activeAgents = agents.filter((a) => a.status === "running" || a.status === "spawning");
    const history = await getTransitionHistory(db, wfRow.id);
    const recentTransitions = history.slice(-3).map((t) =>
      `\`${t.from_state}\` → \`${t.to_state}\` (${t.event_type}, by ${t.triggered_by})`
    ).join("\n");

    const statusMsg = [
      `**Zapbot Status: #${issueNumber}**`,
      "",
      `**State:** \`${wfRow.state}\``,
      `**Level:** ${wfRow.level}`,
      `**Active agents:** ${activeAgents.length > 0 ? activeAgents.map((a) => `${a.role} (${a.status})`).join(", ") : "none"}`,
      "",
      "**Recent transitions:**",
      recentTransitions || "_(none)_",
    ].join("\n");

    await executeSideEffects([{ type: "post_comment", issueNumber, body: statusMsg }], repo);
    return { status: 200, body: "status posted" };
  }

  // ── retry ────────────────────────────────────────────────────────
  if (cmdLower === "retry") {
    const wfRow = await getWorkflowByIssue(db, issueNumber, repo);
    if (!wfRow) {
      await executeSideEffects([{
        type: "post_comment", issueNumber,
        body: "No workflow found for this issue. Nothing to retry.",
      }], repo);
      return { status: 200, body: "no workflow" };
    }

    if (TERMINAL_STATES.has(wfRow.state)) {
      await executeSideEffects([{
        type: "post_comment", issueNumber,
        body: `This workflow is in a terminal state (\`${wfRow.state}\`). Cannot retry.`,
      }], repo);
      return { status: 200, body: "terminal state" };
    }

    const agents = await getAgentSessions(db, wfRow.id);
    const liveAgents = agents.filter((a) => a.status === "running" || a.status === "spawning");
    if (liveAgents.length > 0) {
      await executeSideEffects([{
        type: "post_comment", issueNumber,
        body: `Agents are still running (${liveAgents.map((a) => a.role).join(", ")}). Wait for them to finish or use \`@${BOT_USERNAME} abandon\` to stop.`,
      }], repo);
      return { status: 200, body: "agents still running" };
    }

    const role = stateToRole(wfRow.state);
    if (!role) {
      await executeSideEffects([{
        type: "post_comment", issueNumber,
        body: `No agent role mapped for state \`${wfRow.state}\`. Cannot retry automatically.`,
      }], repo);
      return { status: 200, body: "no role for state" };
    }

    log.info(`Retrying ${role} agent for #${issueNumber} via mention`, { issueNumber, role });
    await executeSideEffects([
      { type: "spawn_agent", role, issueNumber },
      { type: "post_comment", issueNumber,
        body: `Retrying. Spawning **${role}** agent per @${triggeredBy}'s request.` },
    ], repo);

    // Audit trail
    await addTransition(db, {
      id: `t-${crypto.randomUUID()}`,
      workflow_id: wfRow.id,
      from_state: wfRow.state,
      to_state: wfRow.state,
      event_type: "mention:retry",
      triggered_by: triggeredBy,
      metadata: JSON.stringify({ command, commentId, role }),
      github_delivery_id: deliveryId,
    });

    return { status: 200, body: `${role} agent re-spawned via mention` };
  }

  // ── abandon ──────────────────────────────────────────────────────
  if (cmdLower === "abandon") {
    const wfRow = await getWorkflowByIssue(db, issueNumber, repo);
    if (!wfRow) {
      await executeSideEffects([{
        type: "post_comment", issueNumber,
        body: "No workflow found for this issue. Nothing to abandon.",
      }], repo);
      return { status: 200, body: "no workflow" };
    }

    if (TERMINAL_STATES.has(wfRow.state)) {
      await executeSideEffects([{
        type: "post_comment", issueNumber,
        body: `This workflow is already in a terminal state (\`${wfRow.state}\`).`,
      }], repo);
      return { status: 200, body: "already terminal" };
    }

    // Feed abandon through the state machine so it gets the same treatment as label-based abandon
    const workflow: Workflow = toWorkflow(wfRow);
    const result = apply(workflow, { type: "label_abandoned", triggeredBy });
    if (result) {
      await withTransaction(db, async (trx) => {
        await updateWorkflowState(trx, workflow.id, result.newState);
        await addTransition(trx, {
          id: `t-${crypto.randomUUID()}`,
          workflow_id: workflow.id,
          from_state: result.transition.from,
          to_state: result.transition.to,
          event_type: "mention:abandon",
          triggered_by: triggeredBy,
          metadata: JSON.stringify({ command, commentId }),
          github_delivery_id: deliveryId,
        });
      });
      await executeSideEffects(result.sideEffects, repo);
    }

    return { status: 200, body: "abandoned via mention" };
  }

  // ── help ─────────────────────────────────────────────────────────
  if (cmdLower === "help") {
    const helpMsg = [
      `**Zapbot Commands**`,
      "",
      `| Command | Description |`,
      `|---------|-------------|`,
      `| \`@${BOT_USERNAME} plan this\` | Start a new workflow (triage → plan → implement → verify) |`,
      `| \`@${BOT_USERNAME} investigate this\` | Spawn an investigator agent to debug |`,
      `| \`@${BOT_USERNAME} implement this\` | Spawn an implementer agent |`,
      `| \`@${BOT_USERNAME} verify this\` | Spawn a QE agent to test and verify |`,
      `| \`@${BOT_USERNAME} status\` | Show current workflow state and active agents |`,
      `| \`@${BOT_USERNAME} retry\` | Re-spawn the last failed agent |`,
      `| \`@${BOT_USERNAME} abandon\` | Stop the workflow |`,
      `| \`@${BOT_USERNAME} help\` | Show this message |`,
      `| \`@${BOT_USERNAME} <message>\` | Send a message to the running agent |`,
    ].join("\n");

    await executeSideEffects([{ type: "post_comment", issueNumber, body: helpMsg }], repo);
    return { status: 200, body: "help posted" };
  }

  // ── free text → forward to running agent ─────────────────────────
  const wfRow = await getWorkflowByIssue(db, issueNumber, repo);
  if (!wfRow) {
    await executeSideEffects([{
      type: "post_comment", issueNumber,
      body: `No workflow found for this issue. Use \`@${BOT_USERNAME} plan this\` to start one, or \`@${BOT_USERNAME} help\` for all commands.`,
    }], repo);
    return { status: 200, body: "no workflow for free text" };
  }

  const agents = await getAgentSessions(db, wfRow.id);
  const liveAgents = agents.filter((a) => a.status === "running" || a.status === "spawning");

  if (liveAgents.length > 0) {
    // Forward to running agent via ao send
    const projectName = repoMap.get(repo)?.projectName;
    if (projectName) {
      try {
        const agentSession = liveAgents[0];
        const aoResp = await fetch(`${AO_URL}/api/sessions/${agentSession.id}/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: `Feedback from @${triggeredBy}: ${command}` }),
        });
        if (aoResp.ok) {
          await executeSideEffects([{
            type: "post_comment", issueNumber,
            body: `Message forwarded to the running **${agentSession.role}** agent.`,
          }], repo);
        } else {
          throw new Error(`ao send returned ${aoResp.status}`);
        }
      } catch (err) {
        log.warn(`Failed to forward message to agent: ${err}`);
        await executeSideEffects([{
          type: "post_comment", issueNumber,
          body: `Could not forward message to the running agent. The agent may have just finished. Try \`@${BOT_USERNAME} status\` to check.`,
        }], repo);
      }
    }
  } else {
    // No live agents — respawn with context
    const role = stateToRole(wfRow.state);
    if (role && !TERMINAL_STATES.has(wfRow.state)) {
      log.info(`Re-spawning ${role} agent for #${issueNumber} with follow-up context`, { issueNumber, role });
      await executeSideEffects([
        { type: "spawn_agent", role, issueNumber },
        { type: "post_comment", issueNumber,
          body: `Previous agent session expired. Starting fresh **${role}** agent with your feedback.` },
      ], repo);
    } else {
      await executeSideEffects([{
        type: "post_comment", issueNumber,
        body: `No active agents and workflow is in \`${wfRow.state}\` state. Use \`@${BOT_USERNAME} retry\` to re-spawn.`,
      }], repo);
    }
  }

  // Audit trail for free text
  await addTransition(db, {
    id: `t-${crypto.randomUUID()}`,
    workflow_id: wfRow.id,
    from_state: wfRow.state,
    to_state: wfRow.state,
    event_type: "mention:message",
    triggered_by: triggeredBy,
    metadata: JSON.stringify({ command: command.slice(0, 200), commentId }),
    github_delivery_id: deliveryId,
  });

  return { status: 200, body: "free text handled" };
}

// ── Core webhook handler ────────────────────────────────────────────

async function handleWebhook(
  eventType: string,
  deliveryId: string,
  payload: any
): Promise<{ status: number; body: string }> {
  const repo: string = payload.repository?.full_name || "";

  // Dedup by delivery ID
  if (!deliveryId) {
    log.warn("Webhook received without delivery ID, skipping dedup", { eventType, action: payload.action });
  }
  if (deliveryId && await hasDeliveryBeenProcessed(db, deliveryId)) {
    log.debug("Duplicate delivery, skipping", { deliveryId });
    return { status: 200, body: "duplicate" };
  }

  log.info(`Webhook: ${eventType}.${payload.action}`, {
    deliveryId,
    repo,
    sender: payload.sender?.login,
  });

  // ── Assignment-based entry point ──────────────────────────────────
  // The bot only starts work when an issue is assigned to it. Labels
  // determine which agent to spawn (triage if no label).
  if (eventType === "issues" && payload.action === "assigned") {
    const assignee: string = payload.assignee?.login || "";
    if (assignee !== BOT_USERNAME) {
      return { status: 200, body: "not assigned to bot" };
    }

    const issueNumber: number = payload.issue.number;
    const author: string = payload.sender?.login || "";
    const intent: string = payload.issue?.title || "";
    const body: string = payload.issue?.body || "";
    const labels: string[] = (payload.issue?.labels || []).map((l: any) => l.name);

    log.info(`Issue #${issueNumber} assigned to ${BOT_USERNAME}, labels: [${labels.join(", ")}]`, {
      issueNumber,
      labels,
      author,
    });

    // Eyes emoji reaction on the issue for immediate feedback
    try {
      await gh.addIssueReaction(repo, issueNumber, "eyes");
    } catch (err) {
      log.warn(`Failed to add eyes reaction to issue #${issueNumber}: ${err}`);
    }


    // Check if a workflow already exists (re-assignment = recovery)
    const existingWf = await getWorkflowByIssue(db, issueNumber, repo);
    if (existingWf) {
      const agents = await getAgentSessions(db, existingWf.id);
      if (allAgentsDead(agents)) {
        // Determine role from label or current state
        const role = labelToRole(labels) ?? stateToRole(existingWf.state) ?? "triage";
        log.info(`Re-spawning ${role} agent for existing workflow ${existingWf.id}`, { issueNumber, role });
        await executeSideEffects([{ type: "spawn_agent", role, issueNumber }], repo);
        return { status: 200, body: `${role} agent re-spawned` };
      }
      log.debug("Workflow already active with live agents", { issueNumber, state: existingWf.state });
      return { status: 200, body: "workflow already active" };
    }

    // No workflow yet — create one based on labels
    if (labels.includes("planning")) {
      // Sub-issue: create in PLANNING, spawn planner
      const wfId = makeWorkflowId(repo, issueNumber);
      const parentMatch = body.match(/Part of #(\d+)/i);
      const parentWorkflowId = parentMatch ? makeWorkflowId(repo, parseInt(parentMatch[1], 10)) : null;
      const deps = parseDependencies(body);

      await upsertWorkflow(db, {
        id: wfId,
        issue_number: issueNumber,
        repo,
        state: "PLANNING",
        level: "sub",
        parent_workflow_id: parentWorkflowId,
        author,
        intent,
        dependencies: serializeDeps(deps),
      });

      await addTransition(db, {
        id: `t-${crypto.randomUUID()}`,
        workflow_id: wfId,
        from_state: "NEW",
        to_state: "PLANNING",
        event_type: "assigned_to_bot",
        triggered_by: author,
        metadata: null,
        github_delivery_id: deliveryId,
      });

      log.info(`Created sub workflow ${wfId} in PLANNING`, { issueNumber, parent: parentWorkflowId });

      if (deps.length > 0) {
        const blocking = await findBlockingDepsAsync(deps, repo);
        if (blocking.length > 0) {
          const blockList = blocking.map((n) => `#${n}`).join(", ");
          log.info(`Sub-issue #${issueNumber} blocked on ${blockList}`, { issueNumber, blocking });
          await executeSideEffects([
            { type: "post_comment", issueNumber,
              body: `Sub-issue tracked. Waiting on ${blockList} to complete before starting planning.` },
          ], repo);
          return { status: 200, body: "sub workflow created (blocked)" };
        }
      }

      await executeSideEffects([
        { type: "spawn_agent", role: "planner", issueNumber },
        { type: "post_comment", issueNumber, body: "Assigned. Spawning planner agent." },
      ], repo);
      return { status: 200, body: "sub workflow created" };
    }

    // Default: parent issue → triage
    await createTriageWorkflow(repo, issueNumber, author, intent, deliveryId);
    return { status: 200, body: "parent workflow created" };
  }

  // ── Mention commands ──────────────────────────────────────────────
  // Handle @mention triggers before the standard state machine pipeline.
  // Mentions are a parallel dispatch layer: some trigger state transitions
  // (plan this, abandon), others are imperative actions (status, retry, help).

  const mapped = mapWebhookToEvent(eventType, payload, BOT_USERNAME);

  if (mapped && mapped.event.type === "mention_command") {
    const mentionResult = await handleMentionCommand(mapped.event, repo, deliveryId);
    return mentionResult;
  }

  // ── Subsequent events (label changes, PRs, etc.) ─────────────────
  // These only act on issues that already have a workflow (bot was
  // previously assigned). No workflow = no action.


  if (!mapped) {
    log.debug("No state machine event for this webhook", { eventType, action: payload.action });
    return { status: 200, body: "no-op" };
  }

  const { event, issueNumber } = mapped;

  // Load workflow
  let wfRow = await getWorkflowByIssue(db, issueNumber, repo);
  if (!wfRow) {
    // Backward compat: plan-approved label on an issue with no workflow
    if (event.type === "label_added" && event.label === "plan-approved") {
      const author = payload.sender?.login || "";
      const intent = payload.issue?.title || "";
      const wfId = makeWorkflowId(repo, issueNumber);

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
    // Same-state label overrides are not errors — the label just matches current state.
    // Don't post a confusing rejection comment for these.
    if (event.type === "label_state_override" && event.targetState === workflow.state) {
      log.debug(`Label matches current state, ignoring`, { issueNumber, state: workflow.state });
      return { status: 200, body: "no-op" };
    }
    const msg = `Cannot apply '${event.type}' — issue #${issueNumber} is in ${workflow.state} state.`;
    log.warn(`REJECTED: ${msg}`, { issueNumber, state: workflow.state, event: event.type });
    await executeSideEffects([
      { type: "post_comment", issueNumber, body: msg },
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

  // When a sub-issue reaches a terminal state, unblock any siblings that depend on it
  if (TERMINAL_STATES.has(result.newState) && workflow.parentWorkflowId) {
    try {
      await unblockDependents(workflow.issueNumber, workflow.parentWorkflowId, repo);
    } catch (err) {
      log.warn(`Failed to unblock dependents after #${workflow.issueNumber} completed: ${err}`);
    }
  }

  // GC: clean up agent sessions when a workflow reaches a terminal state
  if (TERMINAL_STATES.has(result.newState)) {
    cleanupWorkflowSessions(db, workflow.id).catch((err) =>
      log.warn(`Post-transition cleanup failed for ${workflow.id}: ${err}`)
    );
  }

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

  const agentStates = new Set(["TRIAGE", "IMPLEMENTING", "INVESTIGATING", "VERIFYING"]);

  for (const wf of active) {
    // Check if the GitHub issue is still open before attempting recovery.
    // Issues closed externally (via GitHub UI or by agents) should not be re-spawned.
    try {
      const issueState = await gh.getIssueState(wf.repo, wf.issue_number);
      if (issueState === "closed") {
        log.info(`Recovery: ${wf.id} — GitHub issue #${wf.issue_number} is closed, marking workflow as DONE`, {
          workflow: wf.id, state: wf.state,
        });
        await updateWorkflowState(db, wf.id, "DONE");
        continue;
      }
    } catch (err) {
      log.warn(`Recovery: ${wf.id} — could not check issue state, skipping (${err})`, {
        workflow: wf.id,
      });
      continue;
    }

    // Sync label to match DB state on every active workflow
    const expectedLabel = STATE_TO_LABEL[wf.state];
    if (expectedLabel) {
      try {
        await gh.addLabel(wf.repo, wf.issue_number, expectedLabel);
      } catch (err) {
        log.warn(`Recovery: failed to sync label for #${wf.issue_number}: ${err}`);
      }
    }

    const agents = await getAgentSessions(db, wf.id);

    if (agentStates.has(wf.state) && allAgentsDead(agents)) {
      const role: AgentRole = wf.state === "TRIAGE" ? "triage"
        : wf.state === "VERIFYING" ? "qe"
        : wf.state === "INVESTIGATING" ? "investigator"
        : "implementer";
      log.warn(`Recovery: ${wf.id} stuck in ${wf.state} with all agents dead, re-spawning ${role}`, {
        workflow: wf.id, state: wf.state, role,
      });
      await executeSideEffects([
        { type: "spawn_agent", role, issueNumber: wf.issue_number },
        { type: "post_comment", issueNumber: wf.issue_number,
          body: `Bridge restarted. Re-spawning ${role} agent for stuck workflow.` },
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
        } catch (err) {
          log.debug(`webhook JSON parse failed: ${err}`);
          return errorResponse(400, "invalid_request", "Request body is not valid JSON.");
        }

        const repoFullName: string = payload.repository?.full_name || "";

        // Reject webhooks from unconfigured repos (only when config is loaded)
        if (repoMap.size > 0 && repoFullName && !repoMap.has(repoFullName)) {
          log.warn("Webhook from unconfigured repo, rejecting", { repo: repoFullName, deliveryId });
          return errorResponse(403, "configuration_error", `Repo '${repoFullName}' is not configured on this bridge.`);
        }

        // Per-repo HMAC verification with shared secret fallback
        const secret = resolveWebhookSecret(repoFullName, repoMap, WEBHOOK_SECRET!);
        if (!(await verifySignature(body, signature, secret))) {
          return errorResponse(401, "signature_error", "Webhook signature verification failed.");
        }

        const result = await handleWebhook(eventType, deliveryId, payload);
        return new Response(result.body, { status: result.status });
      }

      // Workflow state API
      if (pathname.match(/^\/api\/workflows\/(\d+)$/) && req.method === "GET") {
        const auth = req.headers.get("authorization");
        if (auth !== `Bearer ${WEBHOOK_SECRET}`) {
          return errorResponse(401, "authentication_error", "Invalid API key. Check your ~/.zapbot/config.json secret field.");
        }
        const issueNumber = parseInt(pathname.split("/").pop()!, 10);
        const repo = url.searchParams.get("repo") || "";
        if (!repo && repoMap.size > 1) {
          return errorResponse(400, "missing_parameter", "Multi-repo bridge requires ?repo=owner/name parameter.");
        }
        const wf = await getWorkflowByIssue(db, issueNumber, repo);
        if (!wf) return errorResponse(404, "not_found", `No workflow found for issue #${issueNumber}.`);

        const subs = wf.level === "parent" ? await getSubWorkflows(db, wf.id) : [];
        const agents = await getAgentSessions(db, wf.id);

        return Response.json({ workflow: wf, subWorkflows: subs, agents });
      }

      // Workflow history API
      if (pathname.match(/^\/api\/workflows\/(\d+)\/history$/) && req.method === "GET") {
        const auth = req.headers.get("authorization");
        if (auth !== `Bearer ${WEBHOOK_SECRET}`) {
          return errorResponse(401, "authentication_error", "Invalid API key. Check your ~/.zapbot/config.json secret field.");
        }
        const issueNumber = parseInt(pathname.split("/")[3], 10);
        const repo = url.searchParams.get("repo") || "";
        if (!repo && repoMap.size > 1) {
          return errorResponse(400, "missing_parameter", "Multi-repo bridge requires ?repo=owner/name parameter.");
        }
        const wf = await getWorkflowByIssue(db, issueNumber, repo);
        if (!wf) return errorResponse(404, "not_found", `No workflow found for issue #${issueNumber}.`);

        const history = await getTransitionHistory(db, wf.id);
        return Response.json({ history });
      }

      // Agent heartbeat
      if (pathname.match(/^\/api\/agents\/[\w-]+\/heartbeat$/) && req.method === "POST") {
        const agentId = pathname.split("/")[3];
        const auth = req.headers.get("authorization");
        if (auth !== `Bearer ${WEBHOOK_SECRET}`) {
          return errorResponse(401, "authentication_error", "Invalid API key. Check your ~/.zapbot/config.json secret field.");
        }
        const session = await getAgentSession(db, agentId);
        if (!session) return errorResponse(404, "not_found", `Agent '${agentId}' not found.`);
        await updateAgentHeartbeat(db, agentId);
        return new Response("ok", { status: 200 });
      }

      // Agent complete
      if (pathname.match(/^\/api\/agents\/[\w-]+\/complete$/) && req.method === "POST") {
        const agentId = pathname.split("/")[3];
        const auth = req.headers.get("authorization");
        if (auth !== `Bearer ${WEBHOOK_SECRET}`) {
          return errorResponse(401, "authentication_error", "Invalid API key. Check your ~/.zapbot/config.json secret field.");
        }
        const session = await getAgentSession(db, agentId);
        if (!session) return errorResponse(404, "not_found", `Agent '${agentId}' not found.`);

        const body = await req.json().catch(() => ({}));
        const completionStatus = body.status || "completed";
        await updateAgentStatus(db, agentId, completionStatus, body.prNumber);
        log.info(`Agent ${agentId} completed`, { agentId, status: completionStatus, role: session.role });

        // Fire state machine events based on agent role when completion is successful.
        // This connects agent completion to the workflow state machine so that
        // finishing an agent actually advances the workflow.
        if (completionStatus === "completed") {
          const wfRow = await getWorkflow(db, session.workflow_id);
          if (wfRow) {
            const workflow: Workflow = toWorkflow(wfRow);
            let event: WorkflowEvent | null = null;

            if (session.role === "triage" && workflow.state === "TRIAGE") {
              // Triage agent completed: fire triage_complete to move TRIAGE → TRIAGED
              event = {
                type: "triage_complete",
                triggeredBy: agentId,
                subIssueNumbers: Array.isArray(body.subIssueNumbers) ? body.subIssueNumbers : [],
              };
            } else if (session.role === "qe" && workflow.state === "VERIFYING") {
              // QE agent completed: fire verified_and_shipped or verification_failed
              if (body.passed === false) {
                event = { type: "verification_failed", triggeredBy: agentId };
              } else {
                event = { type: "verified_and_shipped", triggeredBy: agentId };
              }
            }

            if (event) {
              const result = apply(workflow, event);
              if (result) {
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
                    github_delivery_id: null,
                  });
                });
                log.info(`Agent completion triggered: ${workflow.id} ${result.transition.from} → ${result.transition.to}`, {
                  agentId,
                  role: session.role,
                  event: event.type,
                });
                await executeSideEffects(result.sideEffects, wfRow.repo);

                // GC: clean up sessions when agent completion triggers terminal state
                if (TERMINAL_STATES.has(result.newState)) {
                  cleanupWorkflowSessions(db, workflow.id).catch((err) =>
                    log.warn(`Agent-complete cleanup failed for ${workflow.id}: ${err}`)
                  );
                }
              }
            }
          }
        }

        return new Response("ok", { status: 200 });
      }

      // CORS preflight for plannotator callbacks
      if (pathname.match(/^\/api\/callbacks\/plannotator\/(\d+)$/) && req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      // Plannotator callback
      if (pathname.match(/^\/api\/callbacks\/plannotator\/(\d+)$/) && req.method === "POST") {

        const issueNumber = parseInt(pathname.split("/").pop()!, 10);
        const body = await req.json().catch(() => ({}));

        // Require valid callback token for authentication
        if (!body.token || typeof body.token !== "string") {
          const resp = errorResponse(401, "authentication_error", "Missing callback token.");
          for (const [k, v] of Object.entries(CORS_HEADERS)) resp.headers.set(k, v);
          return resp;
        }
        const stored = callbackTokens.get(body.token);
        if (!stored) {
          const resp = errorResponse(401, "authentication_error", "Invalid or expired callback token.");
          for (const [k, v] of Object.entries(CORS_HEADERS)) resp.headers.set(k, v);
          return resp;
        }
        // Verify the token is scoped to this issue number
        if (stored.issueNumber !== issueNumber) {
          const resp = errorResponse(403, "authorization_error", `Callback token is not valid for issue #${issueNumber}.`);
          for (const [k, v] of Object.entries(CORS_HEADERS)) resp.headers.set(k, v);
          return resp;
        }
        // Repo comes from the trusted token store only, never from request body
        const repo = stored.repo;

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
          for (const [k, v] of Object.entries(CORS_HEADERS)) resp.headers.set(k, v);
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
        for (const [k, v] of Object.entries(CORS_HEADERS)) resp.headers.set(k, v);
        return resp;
      }

      // Installation token broker for safer-publish (bot attribution).
      // Thin wrapper around getInstallationToken() — the existing singleton
      // at src/github/client.ts:200-218. No new mint path.
      if (pathname === "/api/tokens/installation" && req.method === "GET") {
        const result: InstallationTokenStatus = await handleInstallationTokenRequest(req, {
          mintToken: getInstallationToken,
          apiKey: WEBHOOK_SECRET!,
          now: () => new Date(),
        });
        const clientIp = req.headers.get("x-forwarded-for") ?? "local";
        log.info("installation_token.request", { status: result.status, client_ip: clientIp });
        return Response.json(result.body, { status: result.status });
      }

      // Token registration for plannotator callbacks (requires API key)
      if (pathname === "/api/tokens" && req.method === "POST") {
        const auth = req.headers.get("authorization");
        if (auth !== `Bearer ${WEBHOOK_SECRET}`) {
          return errorResponse(401, "authentication_error", "Invalid API key. Check your ~/.zapbot/config.json secret field.");
        }
        const body = await req.json().catch(() => ({}));
        const { token, issueNumber, repo } = body;
        if (!token || typeof token !== "string" || issueNumber == null || typeof issueNumber !== "number") {
          return errorResponse(400, "invalid_request", "Missing or invalid token/issueNumber in request body.");
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

      return errorResponse(404, "not_found", "Resource not found.");
    },
  });

  log.info(`Webhook bridge listening on http://localhost:${PORT}`);

  // Periodic token cleanup (every hour)
  const tokenCleanupInterval = setInterval(pruneExpiredTokens, 60 * 60 * 1000);

  // Periodic session GC sweep (every hour) — catches leaked sessions
  const gcSweepInterval = setInterval(() => {
    cleanupStaleSessions(db).catch((err) => log.error(`GC sweep failed: ${err}`));
  }, 60 * 60 * 1000);

  // Run initial GC sweep on startup to clean backlog
  cleanupStaleSessions(db).catch((err) => log.error(`Initial GC sweep failed: ${err}`));

  // Live agent progress poller (updates GitHub comments with task status)
  const progressPoller = startProgressPoller(db, gh);

  // Gateway registration (if configured)
  let gatewayCleanup: (() => Promise<void>) | null = null;
  const gatewayUrl = process.env.ZAPBOT_GATEWAY_URL;
  const gatewayToken = process.env.ZAPBOT_GATEWAY_TOKEN;
  const gatewaySecret = process.env.ZAPBOT_GATEWAY_SECRET;
  const bridgeUrl = process.env.ZAPBOT_BRIDGE_URL;
  const hasGatewayAuth = !!(gatewayToken || gatewaySecret);

  if (gatewayUrl && hasGatewayAuth && bridgeUrl) {
    const repos = Array.from(repoMap.keys());
    if (repos.length > 0) {
      try {
        gatewayCleanup = await setupGateway(
          { gatewayUrl, token: gatewayToken, secret: gatewaySecret },
          repos,
          bridgeUrl,
        );
        log.info(`Registered ${repos.length} repo(s) with gateway at ${gatewayUrl}`);
      } catch (err) {
        log.error(`Failed to register with gateway: ${err}`);
      }
    }
  } else if (gatewayUrl) {
    log.warn("ZAPBOT_GATEWAY_URL is set but ZAPBOT_GATEWAY_TOKEN/ZAPBOT_GATEWAY_SECRET or ZAPBOT_BRIDGE_URL is missing — skipping gateway registration");
  }

  // Graceful shutdown
  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("Shutting down...");
    stopHeartbeatChecker();
    cancelPendingRetries();
    progressPoller.stop();
    clearInterval(tokenCleanupInterval);
    clearInterval(gcSweepInterval);
    if (gatewayCleanup) {
      await gatewayCleanup();
    }
    server.stop();
    await db.destroy();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.error(`Fatal: ${err}`);
  process.exit(1);
});
