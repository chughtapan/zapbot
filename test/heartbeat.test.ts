import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Kysely } from "kysely";
import { initDatabase, type Database } from "../src/store/database.js";
import {
  createAgentSession,
  upsertWorkflow,
  getAgentSession,
  getStaleAgents,
  updateAgentStatus,
} from "../src/store/queries.js";
import {
  startHeartbeatChecker,
  stopHeartbeatChecker,
} from "../src/agents/heartbeat.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

let db: Kysely<Database>;
let dbPath: string;

/**
 * Advance fake timers and flush microtasks so async setInterval callbacks complete.
 */
async function advanceAndFlush(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms);
  // Give async callbacks time to settle
  await new Promise((r) => {
    vi.useRealTimers();
    setTimeout(r, 50);
  });
  vi.useFakeTimers();
}

beforeEach(async () => {
  vi.useFakeTimers();
  dbPath = path.join(
    os.tmpdir(),
    `zapbot-hb-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  // initDatabase needs real timers for SQLite
  vi.useRealTimers();
  db = await initDatabase(dbPath);
  vi.useFakeTimers();

  // Create a parent workflow for agent sessions
  await upsertWorkflow(db, {
    id: "wf-hb",
    issue_number: 1,
    repo: "owner/repo",
    state: "IMPLEMENTING",
    level: "sub",
    parent_workflow_id: null,
    author: "tester",
    intent: "heartbeat test",
  });
});

afterEach(async () => {
  stopHeartbeatChecker();
  vi.useRealTimers();
  await db.destroy();
  try { fs.unlinkSync(dbPath); } catch {}
  try { fs.unlinkSync(dbPath + "-wal"); } catch {}
  try { fs.unlinkSync(dbPath + "-shm"); } catch {}
});

async function createStaleAgent(id: string): Promise<void> {
  await createAgentSession(db, {
    id,
    workflow_id: "wf-hb",
    role: "implementer",
    worktree_path: null,
    pr_number: null,
  });
  // Set heartbeat to 20 minutes ago (well past the 15-min timeout)
  const oldTime = Math.floor(Date.now() / 1000) - 1200;
  await db
    .updateTable("agent_sessions")
    .set({ last_heartbeat: oldTime, status: "running" })
    .where("id", "=", id)
    .execute();
}

describe("heartbeat checker", () => {
  it("marks stale agents as timed out", async () => {
    await createStaleAgent("agent-stale-1");

    startHeartbeatChecker(db);

    // Advance past the 5-minute check interval and flush async callbacks
    await advanceAndFlush(5 * 60 * 1000 + 100);

    const session = await getAgentSession(db, "agent-stale-1");
    expect(session!.status).toBe("timeout");
    expect(session!.completed_at).not.toBeNull();
  });

  it("clears old interval when called twice", async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    startHeartbeatChecker(db);
    startHeartbeatChecker(db);

    // clearInterval should have been called once (to clear the first interval)
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

    clearIntervalSpy.mockRestore();
  });

  it("stops the checker when stopHeartbeatChecker is called", async () => {
    await createStaleAgent("agent-stale-stop");

    startHeartbeatChecker(db);
    stopHeartbeatChecker();

    // Advance past check interval -- nothing should happen since we stopped
    await advanceAndFlush(5 * 60 * 1000 + 100);

    const session = await getAgentSession(db, "agent-stale-stop");
    expect(session!.status).toBe("running"); // still running, not timed out
  });

  it("calls onAgentFailed callback for each stale agent", async () => {
    await createStaleAgent("agent-cb-1");
    await createStaleAgent("agent-cb-2");

    const onFailed = vi.fn();
    startHeartbeatChecker(db, onFailed);

    // Advance past the check interval and flush async callbacks
    await advanceAndFlush(5 * 60 * 1000 + 100);

    expect(onFailed).toHaveBeenCalledTimes(2);
    const calledIds = onFailed.mock.calls.map((c: unknown[]) => c[1]).sort();
    expect(calledIds).toEqual(["agent-cb-1", "agent-cb-2"]);

    // Verify first arg is the db instance
    expect(onFailed.mock.calls[0][0]).toBe(db);
  });
});
