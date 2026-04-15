import { Kysely, sql } from "kysely";
import type { Database, WorkflowTable, AgentSessionTable, TransitionTable } from "./database.js";

type WorkflowInsert = Omit<WorkflowTable, "created_at" | "updated_at" | "draft_review_cycles" | "dependencies"> & {
  draft_review_cycles?: number;
  dependencies?: string | null;
};
type AgentInsert = Omit<AgentSessionTable, "status" | "retry_count" | "max_retries" | "last_heartbeat" | "spawned_at" | "completed_at"> & {
  status?: string;
  max_retries?: number;
};
type TransitionInsert = Omit<TransitionTable, "created_at">;

// ── Workflows ───────────────────────────────────────────────────────

export async function getWorkflow(
  db: Kysely<Database>,
  id: string
): Promise<WorkflowTable | undefined> {
  return db.selectFrom("workflows").selectAll().where("id", "=", id).executeTakeFirst();
}

export async function getWorkflowByIssue(
  db: Kysely<Database>,
  issueNumber: number,
  repo: string
): Promise<WorkflowTable | undefined> {
  return db
    .selectFrom("workflows")
    .selectAll()
    .where("issue_number", "=", issueNumber)
    .where("repo", "=", repo)
    .executeTakeFirst();
}

export async function upsertWorkflow(
  db: Kysely<Database>,
  workflow: WorkflowInsert
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .insertInto("workflows")
    .values({
      ...workflow,
      draft_review_cycles: workflow.draft_review_cycles ?? 0,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.column("id").doUpdateSet({
        state: workflow.state,
        intent: workflow.intent,
        updated_at: now,
      })
    )
    .execute();
}

export async function updateWorkflowState(
  db: Kysely<Database>,
  id: string,
  state: string,
  updates?: Partial<Pick<WorkflowTable, "draft_review_cycles">>
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .updateTable("workflows")
    .set({
      state,
      updated_at: now,
      ...updates,
    })
    .where("id", "=", id)
    .execute();
}

export async function getSubWorkflows(
  db: Kysely<Database>,
  parentWorkflowId: string
): Promise<WorkflowTable[]> {
  return db
    .selectFrom("workflows")
    .selectAll()
    .where("parent_workflow_id", "=", parentWorkflowId)
    .execute();
}

// ── Agent Sessions ──────────────────────────────────────────────────

export async function createAgentSession(
  db: Kysely<Database>,
  session: AgentInsert
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .insertInto("agent_sessions")
    .values({
      ...session,
      status: session.status ?? "spawning",
      retry_count: 0,
      max_retries: session.max_retries ?? 2,
      last_heartbeat: now,
      spawned_at: now,
      completed_at: null,
    })
    .execute();
}

export async function getAgentSessions(
  db: Kysely<Database>,
  workflowId: string
): Promise<AgentSessionTable[]> {
  return db
    .selectFrom("agent_sessions")
    .selectAll()
    .where("workflow_id", "=", workflowId)
    .execute();
}

export async function getAgentSession(
  db: Kysely<Database>,
  agentId: string
): Promise<AgentSessionTable | undefined> {
  return db
    .selectFrom("agent_sessions")
    .selectAll()
    .where("id", "=", agentId)
    .executeTakeFirst();
}

export async function updateAgentHeartbeat(
  db: Kysely<Database>,
  agentId: string
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .updateTable("agent_sessions")
    .set({ last_heartbeat: now })
    .where("id", "=", agentId)
    .execute();
}

export async function updateAgentStatus(
  db: Kysely<Database>,
  agentId: string,
  status: string,
  prNumber?: number
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const update: Record<string, unknown> = { status };
  if (status === "completed" || status === "failed" || status === "timeout") {
    update.completed_at = now;
  }
  if (prNumber !== undefined) {
    update.pr_number = prNumber;
  }
  await db
    .updateTable("agent_sessions")
    .set(update)
    .where("id", "=", agentId)
    .execute();
}

export async function incrementRetryCount(
  db: Kysely<Database>,
  agentId: string
): Promise<void> {
  await db
    .updateTable("agent_sessions")
    .set((eb) => ({ retry_count: eb("retry_count", "+", 1) }))
    .where("id", "=", agentId)
    .execute();
}

export async function getStaleAgents(
  db: Kysely<Database>,
  timeoutSeconds: number = 900 // 15 minutes
): Promise<AgentSessionTable[]> {
  const cutoff = Math.floor(Date.now() / 1000) - timeoutSeconds;
  return db
    .selectFrom("agent_sessions")
    .selectAll()
    .where("status", "in", ["spawning", "running"])
    .where("last_heartbeat", "<", cutoff)
    .execute();
}

// ── Transitions ─────────────────────────────────────────────────────

export async function addTransition(
  db: Kysely<Database>,
  transition: TransitionInsert
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .insertInto("transitions")
    .values({ ...transition, created_at: now })
    .execute();
}

export async function getTransitionHistory(
  db: Kysely<Database>,
  workflowId: string
): Promise<TransitionTable[]> {
  return db
    .selectFrom("transitions")
    .selectAll()
    .where("workflow_id", "=", workflowId)
    .orderBy("created_at", "asc")
    .execute();
}

export async function hasDeliveryBeenProcessed(
  db: Kysely<Database>,
  deliveryId: string
): Promise<boolean> {
  const result = await db
    .selectFrom("transitions")
    .select(sql<number>`1`.as("exists"))
    .where("github_delivery_id", "=", deliveryId)
    .executeTakeFirst();
  return result !== undefined;
}

// ── Transaction helper ──────────────────────────────────────────────

export async function withTransaction<T>(
  db: Kysely<Database>,
  fn: (trx: Kysely<Database>) => Promise<T>
): Promise<T> {
  return db.transaction().execute(fn);
}
