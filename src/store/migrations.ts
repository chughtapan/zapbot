import { Kysely, sql } from "kysely";
import type { Database } from "./database.js";

export async function runMigrations(db: Kysely<Database>): Promise<void> {
  // Create migration tracking table
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `.execute(db);

  const applied = await sql<{ name: string }>`
    SELECT name FROM _migrations ORDER BY name
  `.execute(db);

  const appliedSet = new Set(applied.rows.map((r) => r.name));

  for (const migration of migrations) {
    if (!appliedSet.has(migration.name)) {
      await migration.up(db);
      await sql`INSERT INTO _migrations (name) VALUES (${migration.name})`.execute(db);
    }
  }
}

interface Migration {
  name: string;
  up: (db: Kysely<Database>) => Promise<void>;
}

const migrations: Migration[] = [
  {
    name: "001_initial",
    async up(db: Kysely<Database>) {
      await db.schema
        .createTable("workflows")
        .addColumn("id", "text", (col) => col.primaryKey())
        .addColumn("issue_number", "integer", (col) => col.notNull())
        .addColumn("repo", "text", (col) => col.notNull())
        .addColumn("state", "text", (col) => col.notNull())
        .addColumn("level", "text", (col) => col.notNull())
        .addColumn("parent_workflow_id", "text")
        .addColumn("author", "text", (col) => col.notNull())
        .addColumn("intent", "text", (col) => col.notNull().defaultTo(""))
        .addColumn("draft_review_cycles", "integer", (col) =>
          col.notNull().defaultTo(0)
        )
        .addColumn("created_at", "integer", (col) =>
          col.notNull().defaultTo(sql`(unixepoch())`)
        )
        .addColumn("updated_at", "integer", (col) =>
          col.notNull().defaultTo(sql`(unixepoch())`)
        )
        .execute();

      await db.schema
        .createIndex("idx_workflows_issue")
        .on("workflows")
        .column("issue_number")
        .execute();

      await db.schema
        .createIndex("idx_workflows_parent")
        .on("workflows")
        .column("parent_workflow_id")
        .execute();

      await db.schema
        .createTable("agent_sessions")
        .addColumn("id", "text", (col) => col.primaryKey())
        .addColumn("workflow_id", "text", (col) =>
          col.notNull().references("workflows.id")
        )
        .addColumn("role", "text", (col) => col.notNull())
        .addColumn("worktree_path", "text")
        .addColumn("pr_number", "integer")
        .addColumn("status", "text", (col) => col.notNull().defaultTo("spawning"))
        .addColumn("retry_count", "integer", (col) => col.notNull().defaultTo(0))
        .addColumn("max_retries", "integer", (col) => col.notNull().defaultTo(2))
        .addColumn("last_heartbeat", "integer", (col) =>
          col.notNull().defaultTo(sql`(unixepoch())`)
        )
        .addColumn("spawned_at", "integer", (col) =>
          col.notNull().defaultTo(sql`(unixepoch())`)
        )
        .addColumn("completed_at", "integer")
        .execute();

      await db.schema
        .createIndex("idx_agent_sessions_workflow")
        .on("agent_sessions")
        .column("workflow_id")
        .execute();

      await db.schema
        .createTable("transitions")
        .addColumn("id", "text", (col) => col.primaryKey())
        .addColumn("workflow_id", "text", (col) =>
          col.notNull().references("workflows.id")
        )
        .addColumn("from_state", "text", (col) => col.notNull())
        .addColumn("to_state", "text", (col) => col.notNull())
        .addColumn("event_type", "text", (col) => col.notNull())
        .addColumn("triggered_by", "text", (col) => col.notNull())
        .addColumn("metadata", "text")
        .addColumn("github_delivery_id", "text")
        .addColumn("created_at", "integer", (col) =>
          col.notNull().defaultTo(sql`(unixepoch())`)
        )
        .execute();

      await db.schema
        .createIndex("idx_transitions_workflow")
        .on("transitions")
        .column("workflow_id")
        .execute();

      await db.schema
        .createIndex("idx_transitions_delivery")
        .on("transitions")
        .column("github_delivery_id")
        .execute();
    },
  },
  {
    name: "003_add_dependencies_column",
    up: async (db: Kysely<Database>) => {
      await sql`ALTER TABLE workflows ADD COLUMN dependencies TEXT DEFAULT NULL`.execute(db);
    },
  },
  {
    name: "004_add_cleanup_columns",
    up: async (db: Kysely<Database>) => {
      await sql`ALTER TABLE agent_sessions ADD COLUMN cleaned_up_at INTEGER DEFAULT NULL`.execute(db);
    },
  },
  {
    name: "005_add_progress_columns",
    up: async (db: Kysely<Database>) => {
      await sql`ALTER TABLE workflows ADD COLUMN progress_comment_id INTEGER DEFAULT NULL`.execute(db);
      await sql`ALTER TABLE agent_sessions ADD COLUMN claude_session_id TEXT DEFAULT NULL`.execute(db);
    },
  },
  {
    name: "006_add_nudge_count",
    up: async (db: Kysely<Database>) => {
      await sql`ALTER TABLE agent_sessions ADD COLUMN nudge_count INTEGER NOT NULL DEFAULT 0`.execute(db);
    },
  },
];
