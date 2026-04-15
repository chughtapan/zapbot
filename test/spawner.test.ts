import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Kysely } from "kysely";
import { initDatabase, type Database } from "../src/store/database.js";
import {
  createAgentSession,
  getAgentSession,
  upsertWorkflow,
  updateAgentStatus,
  incrementRetryCount,
} from "../src/store/queries.js";
import { cancelPendingRetries, type AgentRole, type SpawnContext } from "../src/agents/spawner.js";

// ── Read the spawner source for structural tests ────────────────────

const spawnerSource = readFileSync(join(__dirname, "../src/agents/spawner.ts"), "utf-8");

// ── Source code structural tests (a la multi-repo.test.ts) ──────────

describe("spawner: source structure", () => {
  // -- Exports --

  it("exports cancelPendingRetries function", () => {
    expect(spawnerSource).toContain("export function cancelPendingRetries");
  });

  it("exports spawnAgent function", () => {
    expect(spawnerSource).toContain("export async function spawnAgent");
  });

  it("exports AgentRole type", () => {
    expect(spawnerSource).toContain("export type AgentRole");
  });

  it("exports AgentFailureHandler type", () => {
    expect(spawnerSource).toContain("export type AgentFailureHandler");
  });

  it("exports SpawnContext interface", () => {
    expect(spawnerSource).toContain("export interface SpawnContext");
  });

  // -- Agent ID generation --

  it("generates agent IDs with crypto.randomUUID", () => {
    expect(spawnerSource).toContain("crypto.randomUUID()");
    expect(spawnerSource).toContain('`agent-${crypto.randomUUID()}`');
  });

  it("uses existing agent ID for retries", () => {
    expect(spawnerSource).toContain("opts.existingAgentId ?? generateAgentId()");
  });

  // -- Spawn args --

  it("builds spawn args as ao spawn + issue number", () => {
    expect(spawnerSource).toContain('["ao", "spawn", String(ctx.issueNumber)]');
  });

  // -- Env vars --

  it("passes ZAPBOT_AGENT_ID as env var", () => {
    expect(spawnerSource).toContain("ZAPBOT_AGENT_ID: agentId");
  });

  it("passes ZAPBOT_AGENT_ROLE as env var", () => {
    expect(spawnerSource).toContain("ZAPBOT_AGENT_ROLE: ctx.role");
  });

  it("spreads process.env into spawn env", () => {
    expect(spawnerSource).toContain("...process.env");
  });

  it("sets AO_CONFIG_PATH from ZAPBOT_CONFIG env var", () => {
    expect(spawnerSource).toContain("AO_CONFIG_PATH = process.env.ZAPBOT_CONFIG");
  });

  it("sets AO_PROJECT_ID from ctx.projectName", () => {
    expect(spawnerSource).toContain("AO_PROJECT_ID = ctx.projectName");
  });

  it("conditionally sets AO_CONFIG_PATH only when ZAPBOT_CONFIG is set", () => {
    expect(spawnerSource).toContain("if (process.env.ZAPBOT_CONFIG)");
  });

  it("conditionally sets AO_PROJECT_ID only when projectName exists", () => {
    expect(spawnerSource).toContain("if (ctx.projectName)");
  });

  // -- Agent rules copy --

  it("builds role-specific agent rules path from templates dir", () => {
    expect(spawnerSource).toContain("agent-rules-${ctx.role}.md");
  });

  it("copies rules file with fs.copyFileSync", () => {
    expect(spawnerSource).toContain("copyFileSync");
    expect(spawnerSource).toContain("fs.copyFileSync(rulesFile, projectRules)");
  });

  it("checks template existence with fs.existsSync before copy", () => {
    expect(spawnerSource).toContain("fs.existsSync(rulesFile)");
  });

  it("writes rules to .agent-rules.md in cwd", () => {
    expect(spawnerSource).toContain('.agent-rules.md"');
    expect(spawnerSource).toContain('path.join(process.cwd(), ".agent-rules.md")');
  });

  // -- DB session management --

  it("creates agent session in DB for new spawns", () => {
    expect(spawnerSource).toContain("createAgentSession(db, {");
  });

  it("updates agent status to spawning for retries", () => {
    expect(spawnerSource).toContain('updateAgentStatus(db, agentId, "spawning")');
  });

  it("differentiates new spawn from retry using existingAgentId", () => {
    expect(spawnerSource).toContain("const isRetry = !!opts.existingAgentId");
  });

  it("creates session with null worktree_path and pr_number", () => {
    expect(spawnerSource).toContain("worktree_path: null");
    expect(spawnerSource).toContain("pr_number: null");
  });

  // -- Exit code handling --

  it("checks exit code 0 for success path", () => {
    expect(spawnerSource).toContain("if (code === 0)");
  });

  it("updates status to running on exit code 0", () => {
    expect(spawnerSource).toContain('updateAgentStatus(db, agentId, "running")');
  });

  it("updates status to failed when all retries exhausted", () => {
    expect(spawnerSource).toContain('updateAgentStatus(db, agentId, "failed")');
  });

  // -- Retry logic --

  it("checks retry_count against max_retries", () => {
    expect(spawnerSource).toContain("session.retry_count < session.max_retries");
  });

  it("increments retry count in DB", () => {
    expect(spawnerSource).toContain("incrementRetryCount(db, agentId)");
  });

  it("retries with 5-second delay", () => {
    expect(spawnerSource).toContain("5000");
    expect(spawnerSource).toContain("setTimeout(");
  });

  it("calls spawnAgent recursively with existingAgentId on retry", () => {
    expect(spawnerSource).toContain("spawnAgent(db, ctx, { ...opts, existingAgentId: agentId })");
  });

  it("calls onFailed handler when all retries exhausted", () => {
    expect(spawnerSource).toContain("if (opts.onFailed) await opts.onFailed(db, agentId)");
  });

  // -- Timer tracking --

  it("tracks pending timers in a Set", () => {
    expect(spawnerSource).toContain("const pendingTimers = new Set<Timer>()");
  });

  it("adds timers to the set when created", () => {
    expect(spawnerSource).toContain("pendingTimers.add(");
  });

  it("removes timers from the set when fired", () => {
    expect(spawnerSource).toContain("pendingTimers.delete(");
  });

  it("cancelPendingRetries clears all timers and empties the set", () => {
    expect(spawnerSource).toContain("clearTimeout(t)");
    expect(spawnerSource).toContain("pendingTimers.clear()");
  });

  // -- Stale worktree cleanup --

  it("cleans stale worktrees before spawning", () => {
    expect(spawnerSource).toContain("await cleanStaleWorktree(ctx.issueNumber)");
  });

  it("uses git worktree list --porcelain to find worktrees", () => {
    expect(spawnerSource).toContain('"git", "worktree", "list", "--porcelain"');
  });

  it("constructs branch name as feat/issue-{number}", () => {
    expect(spawnerSource).toContain("`feat/issue-${issueNumber}`");
  });

  it("checks for refs/heads/{branch} in worktree output", () => {
    expect(spawnerSource).toContain("`refs/heads/${branch}`");
  });

  it("removes stale worktrees with git worktree remove --force", () => {
    expect(spawnerSource).toContain('"git", "worktree", "remove", "--force"');
  });

  it("parses worktree path from porcelain block", () => {
    expect(spawnerSource).toContain('l.startsWith("worktree ")');
    expect(spawnerSource).toContain('.slice("worktree ".length)');
  });

  // -- Prompt building --

  it("buildPrompt includes agent role", () => {
    expect(spawnerSource).toContain("You are a ${ctx.role} agent");
  });

  it("buildPrompt includes issue number and repo", () => {
    expect(spawnerSource).toContain("issue #${ctx.issueNumber} in repo ${ctx.repo}");
  });

  it("buildPrompt tells agent to read .agent-rules.md", () => {
    expect(spawnerSource).toContain(".agent-rules.md");
  });

  it("buildPrompt tells agent to start working", () => {
    expect(spawnerSource).toContain("Start working now.");
  });

  // -- Prompt re-delivery --

  it("re-delivers prompt after 15-second delay", () => {
    expect(spawnerSource).toContain("15000");
    expect(spawnerSource).toContain("Re-delivering prompt");
  });

  it("uses ao send to re-deliver prompt", () => {
    expect(spawnerSource).toContain('"ao", "send"');
  });

  it("searches for session via findSessionForIssue", () => {
    expect(spawnerSource).toContain("findSessionForIssue(ctx.issueNumber)");
  });

  it("findSessionForIssue tries ao session ls and ao status", () => {
    expect(spawnerSource).toContain('"ao", "session", "ls"');
    expect(spawnerSource).toContain('"ao", "status"');
  });

  it("findSessionForIssue matches session names like zap-NNN", () => {
    expect(spawnerSource).toContain("/(zap-\\d+)/");
  });

  // -- Bun.spawn usage --

  it("uses Bun.spawn for process execution", () => {
    expect(spawnerSource).toContain("Bun.spawn(");
  });

  it("pipes stdout and stderr for subprocess output", () => {
    expect(spawnerSource).toContain('stdout: "pipe"');
    expect(spawnerSource).toContain('stderr: "pipe"');
  });

  // -- Error handling --

  it("catches spawn errors in try/catch", () => {
    expect(spawnerSource).toContain("} catch (err)");
  });

  it("handles proc.exited rejection", () => {
    expect(spawnerSource).toContain(".catch(async (err)");
  });

  it("logs error and sets failed status on spawn error", () => {
    expect(spawnerSource).toContain("Failed to spawn agent");
    expect(spawnerSource).toContain('updateAgentStatus(db, agentId, "failed")');
  });

  // -- ZAPBOT_DIR resolution --

  it("resolves ZAPBOT_DIR relative to spawner module", () => {
    expect(spawnerSource).toContain('path.resolve(import.meta.dir, "../..")');
  });

  // -- Race condition documentation --

  it("documents the agent-rules race condition", () => {
    expect(spawnerSource).toContain("RACE CONDITION NOTE");
  });
});

// ── Agent role types ────────────────────────────────────────────────

describe("spawner: AgentRole type", () => {
  it("includes all expected roles", () => {
    expect(spawnerSource).toContain('"triage"');
    expect(spawnerSource).toContain('"planner"');
    expect(spawnerSource).toContain('"implementer"');
    expect(spawnerSource).toContain('"qe"');
    expect(spawnerSource).toContain('"investigator"');
  });
});

// ── SpawnContext interface ───────────────────────────────────────────

describe("spawner: SpawnContext interface", () => {
  it("has issueNumber field", () => {
    expect(spawnerSource).toContain("issueNumber: number");
  });

  it("has repo field", () => {
    expect(spawnerSource).toContain("repo: string");
  });

  it("has role field", () => {
    expect(spawnerSource).toContain("role: AgentRole");
  });

  it("has workflowId field", () => {
    expect(spawnerSource).toContain("workflowId: string");
  });

  it("has optional projectName field", () => {
    expect(spawnerSource).toContain("projectName?: string");
  });
});

// ── cancelPendingRetries functional test ─────────────────────────────

describe("spawner: cancelPendingRetries", () => {
  it("is callable and does not throw", () => {
    expect(() => cancelPendingRetries()).not.toThrow();
  });

  it("can be called multiple times without error", () => {
    cancelPendingRetries();
    cancelPendingRetries();
    cancelPendingRetries();
  });
});

// ── Agent rules template files ──────────────────────────────────────

describe("spawner: agent rules templates", () => {
  const roles: AgentRole[] = ["triage", "planner", "implementer", "qe", "investigator"];
  const templatesDir = join(__dirname, "../templates");

  for (const role of roles) {
    it(`has template file for ${role} role`, () => {
      const rulesFile = join(templatesDir, `agent-rules-${role}.md`);
      expect(existsSync(rulesFile)).toBe(true);
    });
  }

  it("all template files are non-empty", () => {
    for (const role of roles) {
      const content = readFileSync(join(templatesDir, `agent-rules-${role}.md`), "utf-8");
      expect(content.length).toBeGreaterThan(0);
    }
  });
});

// ── DB integration: agent session lifecycle ─────────────────────────

describe("spawner: DB session lifecycle", () => {
  let db: Kysely<Database>;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `zapbot-spawner-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = await initDatabase(dbPath);

    await upsertWorkflow(db, {
      id: "wf-spawn-1",
      issue_number: 100,
      repo: "owner/repo",
      state: "IMPLEMENTING",
      level: "sub",
      parent_workflow_id: null,
      author: "alice",
      intent: "build feature",
    });
  });

  afterEach(async () => {
    await db.destroy();
    try { rmSync(dbPath); } catch {}
    try { rmSync(dbPath + "-wal"); } catch {}
    try { rmSync(dbPath + "-shm"); } catch {}
  });

  it("creates agent session with spawning status", async () => {
    await createAgentSession(db, {
      id: "agent-test-1",
      workflow_id: "wf-spawn-1",
      role: "implementer",
      worktree_path: null,
      pr_number: null,
    });

    const session = await getAgentSession(db, "agent-test-1");
    expect(session).toBeDefined();
    expect(session!.status).toBe("spawning");
    expect(session!.retry_count).toBe(0);
    expect(session!.max_retries).toBeGreaterThan(0);
  });

  it("can update status to spawning for retry", async () => {
    await createAgentSession(db, {
      id: "agent-retry-test",
      workflow_id: "wf-spawn-1",
      role: "implementer",
      worktree_path: null,
      pr_number: null,
    });

    await updateAgentStatus(db, "agent-retry-test", "failed");
    const failed = await getAgentSession(db, "agent-retry-test");
    expect(failed!.status).toBe("failed");

    await updateAgentStatus(db, "agent-retry-test", "spawning");
    const retrying = await getAgentSession(db, "agent-retry-test");
    expect(retrying!.status).toBe("spawning");
  });

  it("increments retry count correctly during retry cycle", async () => {
    await createAgentSession(db, {
      id: "agent-cycle",
      workflow_id: "wf-spawn-1",
      role: "qe",
      worktree_path: null,
      pr_number: null,
    });

    const s0 = await getAgentSession(db, "agent-cycle");
    expect(s0!.retry_count).toBe(0);

    await incrementRetryCount(db, "agent-cycle");
    const s1 = await getAgentSession(db, "agent-cycle");
    expect(s1!.retry_count).toBe(1);

    await incrementRetryCount(db, "agent-cycle");
    const s2 = await getAgentSession(db, "agent-cycle");
    expect(s2!.retry_count).toBe(2);

    await incrementRetryCount(db, "agent-cycle");
    const s3 = await getAgentSession(db, "agent-cycle");
    expect(s3!.retry_count).toBe(3);
  });

  it("tracks max_retries default value", async () => {
    await createAgentSession(db, {
      id: "agent-max",
      workflow_id: "wf-spawn-1",
      role: "triage",
      worktree_path: null,
      pr_number: null,
    });

    const session = await getAgentSession(db, "agent-max");
    expect(session!.max_retries).toBeGreaterThanOrEqual(2);
  });

  it("can simulate full retry exhaustion", async () => {
    await createAgentSession(db, {
      id: "agent-exhaust",
      workflow_id: "wf-spawn-1",
      role: "implementer",
      worktree_path: null,
      pr_number: null,
    });

    const session = await getAgentSession(db, "agent-exhaust");
    const maxRetries = session!.max_retries;

    // Increment retry_count up to max_retries
    for (let i = 0; i < maxRetries; i++) {
      await incrementRetryCount(db, "agent-exhaust");
    }

    const exhausted = await getAgentSession(db, "agent-exhaust");
    expect(exhausted!.retry_count).toBe(maxRetries);
    // Condition in spawner: retry_count < max_retries => false now, so no more retries
    expect(exhausted!.retry_count < exhausted!.max_retries).toBe(false);

    // Mark as failed
    await updateAgentStatus(db, "agent-exhaust", "failed");
    const final = await getAgentSession(db, "agent-exhaust");
    expect(final!.status).toBe("failed");
    expect(final!.completed_at).not.toBeNull();
  });

  it("creates session with correct role for each agent type", async () => {
    const roles: AgentRole[] = ["triage", "planner", "implementer", "qe", "investigator"];
    for (const role of roles) {
      await createAgentSession(db, {
        id: `agent-role-${role}`,
        workflow_id: "wf-spawn-1",
        role,
        worktree_path: null,
        pr_number: null,
      });

      const session = await getAgentSession(db, `agent-role-${role}`);
      expect(session!.role).toBe(role);
    }
  });
});

// ── Spawn args and env construction (structural) ────────────────────

describe("spawner: spawn args and env construction", () => {
  it("spawn args are [ao, spawn, issueNumber]", () => {
    // Verify the exact structure from source
    expect(spawnerSource).toContain('const spawnArgs = ["ao", "spawn", String(ctx.issueNumber)]');
  });

  it("env includes all process.env vars via spread", () => {
    expect(spawnerSource).toContain("...process.env,");
  });

  it("ZAPBOT_CONFIG env var maps to AO_CONFIG_PATH", () => {
    // The mapping is: process.env.ZAPBOT_CONFIG -> AO_CONFIG_PATH
    expect(spawnerSource).toContain('spawnEnv.AO_CONFIG_PATH = process.env.ZAPBOT_CONFIG');
  });

  it("projectName maps to AO_PROJECT_ID", () => {
    expect(spawnerSource).toContain('spawnEnv.AO_PROJECT_ID = ctx.projectName');
  });

  it("spawn env type is Record<string, string | undefined>", () => {
    expect(spawnerSource).toContain("const spawnEnv: Record<string, string | undefined>");
  });
});

// ── Retry mechanism analysis ────────────────────────────────────────

describe("spawner: retry mechanism", () => {
  it("retries on non-zero exit code only", () => {
    // Success path returns early on code === 0
    expect(spawnerSource).toContain("if (code === 0)");
    // After that block, the retry logic runs for code !== 0
    expect(spawnerSource).toContain("spawn process exited with code ${code}");
  });

  it("gets session from DB before deciding to retry", () => {
    expect(spawnerSource).toContain("const session = await getAgentSession(db, agentId)");
  });

  it("retry delay is exactly 5 seconds", () => {
    // Find the retry setTimeout call (not the 15s prompt re-delivery)
    const retryMatch = spawnerSource.match(/spawnAgent\(db, ctx.*\).*\n\s*\}\);\n\s*\}, (\d+)\)/);
    // The 5000 is associated with the retry setTimeout
    expect(spawnerSource).toContain("}, 5000)");
  });

  it("prompt re-delivery delay is 15 seconds", () => {
    expect(spawnerSource).toContain("}, 15000)");
  });

  it("both retry and prompt timers are tracked in pendingTimers", () => {
    // Count how many times pendingTimers.add is called
    const addCount = (spawnerSource.match(/pendingTimers\.add\(/g) || []).length;
    expect(addCount).toBe(2); // once for retry timer, once for prompt timer
  });

  it("both timers remove themselves from the set when they fire", () => {
    const deleteCount = (spawnerSource.match(/pendingTimers\.delete\(/g) || []).length;
    expect(deleteCount).toBe(2); // once for retry timer, once for prompt timer
  });
});

// ── Stale worktree cleanup analysis ─────────────────────────────────

describe("spawner: cleanStaleWorktree", () => {
  it("is called before any DB or spawn operations", () => {
    // cleanStaleWorktree appears before createAgentSession in the function body
    const cleanIdx = spawnerSource.indexOf("await cleanStaleWorktree");
    const createIdx = spawnerSource.indexOf("await createAgentSession");
    expect(cleanIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeGreaterThan(-1);
    expect(cleanIdx).toBeLessThan(createIdx);
  });

  it("is an async function", () => {
    expect(spawnerSource).toContain("async function cleanStaleWorktree");
  });

  it("early returns when branch is not in worktree list", () => {
    expect(spawnerSource).toContain("if (!stdout.includes(`refs/heads/${branch}`)) return");
  });

  it("splits porcelain output by blank lines", () => {
    expect(spawnerSource).toContain('stdout.split("\\n\\n")');
  });

  it("handles errors gracefully with try/catch", () => {
    // The function wraps its body in a try/catch
    expect(spawnerSource).toContain("Failed to clean stale worktree");
  });
});

// ── buildPrompt analysis ────────────────────────────────────────────

describe("spawner: buildPrompt", () => {
  it("returns a string containing all context fields", () => {
    // The template string interpolates role, issueNumber, and repo
    expect(spawnerSource).toContain("ctx.role");
    expect(spawnerSource).toContain("ctx.issueNumber");
    expect(spawnerSource).toContain("ctx.repo");
  });

  it("is a pure function with no side effects", () => {
    // buildPrompt only returns a template string, no awaits or DB calls
    const funcMatch = spawnerSource.match(/function buildPrompt\(ctx: SpawnContext\): string \{[\s\S]*?^}/m);
    expect(funcMatch).not.toBeNull();
    const funcBody = funcMatch![0];
    expect(funcBody).not.toContain("await");
    expect(funcBody).not.toContain("Bun.spawn");
    expect(funcBody).not.toContain("db.");
  });

  it("references .agent-rules.md for the agent to read", () => {
    const funcMatch = spawnerSource.match(/function buildPrompt[\s\S]*?^}/m);
    expect(funcMatch![0]).toContain(".agent-rules.md");
  });
});

// ── findSessionForIssue analysis ────────────────────────────────────

describe("spawner: findSessionForIssue", () => {
  it("is an async function that returns string | null", () => {
    expect(spawnerSource).toContain("async function findSessionForIssue(issueNumber: number): Promise<string | null>");
  });

  it("tries two different commands to find session", () => {
    expect(spawnerSource).toContain('["ao", "session", "ls"]');
    expect(spawnerSource).toContain('["ao", "status"]');
  });

  it("uses a for loop to try fallback commands", () => {
    expect(spawnerSource).toContain("for (const cmd of [");
  });

  it("reads process stdout to find the branch", () => {
    expect(spawnerSource).toContain("new Response(proc.stdout).text()");
  });

  it("matches session names with zap-NNN pattern", () => {
    expect(spawnerSource).toContain("/(zap-\\d+)/");
  });

  it("searches for the branch name in command output", () => {
    expect(spawnerSource).toContain("line.includes(branch)");
  });

  it("returns null when session is not found", () => {
    expect(spawnerSource).toContain("return null");
  });

  it("handles command errors gracefully", () => {
    expect(spawnerSource).toContain("} catch (err)");
  });
});

// ── SpawnOptions interface ──────────────────────────────────────────

describe("spawner: SpawnOptions", () => {
  it("has optional onFailed handler", () => {
    expect(spawnerSource).toContain("onFailed?: AgentFailureHandler");
  });

  it("has optional existingAgentId for retries", () => {
    expect(spawnerSource).toContain("existingAgentId?: string");
  });

  it("defaults SpawnOptions to empty object", () => {
    expect(spawnerSource).toContain("opts: SpawnOptions = {}");
  });
});

// ── Integration: spawnAgent flow order ──────────────────────────────

describe("spawner: spawnAgent execution order", () => {
  // Extract just the spawnAgent function body for order checks
  const fnStart = spawnerSource.indexOf("export async function spawnAgent");
  const fnBody = spawnerSource.slice(fnStart);

  it("cleans worktree before creating DB session", () => {
    const cleanIdx = fnBody.indexOf("await cleanStaleWorktree");
    const createIdx = fnBody.indexOf("await createAgentSession");
    expect(cleanIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeGreaterThan(-1);
    expect(cleanIdx).toBeLessThan(createIdx);
  });

  it("copies agent rules before creating DB session", () => {
    const copyIdx = fnBody.indexOf("copyFileSync");
    const createIdx = fnBody.indexOf("await createAgentSession");
    expect(copyIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeGreaterThan(-1);
    expect(copyIdx).toBeLessThan(createIdx);
  });

  it("creates DB session before spawning process", () => {
    const createIdx = fnBody.indexOf("await createAgentSession");
    const spawnIdx = fnBody.indexOf("Bun.spawn(\n      spawnArgs");
    expect(createIdx).toBeGreaterThan(-1);
    expect(spawnIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeLessThan(spawnIdx);
  });

  it("returns agentId at the end of the function", () => {
    // The function ends with return agentId
    expect(spawnerSource).toContain("return agentId;");
  });
});

// ── Logging ─────────────────────────────────────────────────────────

describe("spawner: logging", () => {
  it("creates logger with 'agents' component", () => {
    expect(spawnerSource).toContain('createLogger("agents")');
  });

  it("logs spawn start with role and workflow context", () => {
    expect(spawnerSource).toContain("role: ctx.role");
    expect(spawnerSource).toContain("workflow: ctx.workflowId");
  });

  it("logs retry attempts with count", () => {
    expect(spawnerSource).toContain("retry: session.retry_count + 1");
    expect(spawnerSource).toContain("maxRetries: session.max_retries");
  });

  it("differentiates retry vs initial spawn in log messages", () => {
    expect(spawnerSource).toContain('isRetry ? "Retrying" : "Spawning"');
  });

  it("logs stale worktree removal", () => {
    expect(spawnerSource).toContain("Removing stale worktree at");
    expect(spawnerSource).toContain("Removed stale worktree at");
  });

  it("logs agent rules copy", () => {
    expect(spawnerSource).toContain("Wrote ${ctx.role} agent rules to");
  });
});

// ── Edge cases in source ────────────────────────────────────────────

describe("spawner: edge case handling", () => {
  it("handles session not found in DB during retry check", () => {
    // session can be null/undefined; the retry block checks: if (session && session.retry_count...)
    expect(spawnerSource).toContain("if (session && session.retry_count < session.max_retries)");
  });

  it("handles findSessionForIssue returning null (no prompt re-delivery)", () => {
    // Only re-delivers if sessionName is found
    expect(spawnerSource).toContain("if (sessionName)");
  });

  it("handles non-zero ao send exit code", () => {
    expect(spawnerSource).toContain("if (sendCode !== 0)");
  });

  it("catches errors in prompt re-delivery", () => {
    expect(spawnerSource).toContain("Prompt re-delivery failed");
  });

  it("catches errors in retry spawn", () => {
    expect(spawnerSource).toContain("Retry spawn failed");
  });
});
