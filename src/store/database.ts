import { Kysely } from "kysely";
import { Database as BunSqliteDatabase } from "bun:sqlite";
import { BunSqliteDialect } from "./dialect.js";
import { runMigrations } from "./migrations.js";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

// ── Table interfaces ────────────────────────────────────────────────

export interface WorkflowTable {
  id: string; // "wf-{issueNumber}"
  issue_number: number;
  repo: string;
  state: string;
  level: string; // "parent" | "sub"
  parent_workflow_id: string | null;
  author: string;
  intent: string;
  draft_review_cycles: number;
  dependencies: string | null; // JSON-encoded number[] — use serializeDeps/deserializeDeps
  created_at: number;
  updated_at: number;
}

/** Serialize dependency issue numbers for DB storage. */
export function serializeDeps(deps: number[]): string | null {
  return deps.length > 0 ? JSON.stringify(deps) : null;
}

/** Deserialize dependency issue numbers from DB. */
export function deserializeDeps(raw: string | null): number[] {
  if (!raw) return [];
  try { return JSON.parse(raw) as number[]; }
  catch { return []; }
}

export interface AgentSessionTable {
  id: string; // "agent-{uuid}"
  workflow_id: string;
  role: string; // "triage" | "planner" | "implementer" | "qe" | "investigator"
  worktree_path: string | null;
  pr_number: number | null;
  status: string; // "spawning" | "running" | "completed" | "failed" | "timeout"
  retry_count: number;
  max_retries: number;
  last_heartbeat: number;
  spawned_at: number;
  completed_at: number | null;
  cleaned_up_at: number | null;
}

export interface TransitionTable {
  id: string;
  workflow_id: string;
  from_state: string;
  to_state: string;
  event_type: string;
  triggered_by: string; // GitHub username or agent ID
  metadata: string | null; // JSON blob
  github_delivery_id: string | null; // for webhook dedup
  created_at: number;
}

export interface Database {
  workflows: WorkflowTable;
  agent_sessions: AgentSessionTable;
  transitions: TransitionTable;
}

// ── Database initialization ─────────────────────────────────────────

const DEFAULT_DB_DIR = path.join(os.homedir(), ".zapbot");
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, "state.db");

export function createDatabase(dbPath?: string): Kysely<Database> {
  const resolvedPath = dbPath ?? DEFAULT_DB_PATH;
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const sqliteDb = new BunSqliteDatabase(resolvedPath);
  sqliteDb.exec("PRAGMA journal_mode = WAL");
  sqliteDb.exec("PRAGMA busy_timeout = 5000");

  const db = new Kysely<Database>({
    dialect: new BunSqliteDialect({ database: sqliteDb }),
  });

  return db;
}

export async function initDatabase(dbPath?: string): Promise<Kysely<Database>> {
  const db = createDatabase(dbPath);
  await runMigrations(db);
  return db;
}
