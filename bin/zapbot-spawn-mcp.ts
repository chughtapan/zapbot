#!/usr/bin/env bun
/**
 * bin/zapbot-spawn-mcp — stdio MCP server that exposes the
 * `request_worker_spawn` tool to the long-lived per-project lead
 * Claude Code session (epic #369 D2).
 *
 * Architecture: the lead session's `~/.zapbot/projects/<slug>/.mcp.json`
 * declares this binary as an MCP server. Claude Code spawns it as a
 * stdio child whenever the session resumes. When the lead session
 * calls the `request_worker_spawn` tool, this process forwards the
 * call as `POST <ZAPBOT_ORCHESTRATOR_URL>/spawn` with the shared
 * secret in `Authorization: Bearer <ZAPBOT_SPAWN_SECRET>` and returns
 * the orchestrator's response back over MCP (epic #369 § "Open
 * architectural questions" Q4).
 *
 * Owns: MCP stdio transport (via `@modelcontextprotocol/sdk`), the
 * `request_worker_spawn` tool registration, schema decoding of the
 * tool input, HTTP forwarding to the orchestrator, and translation
 * of the orchestrator's HTTP error envelope back into MCP tool
 * errors the lead session can reason about.
 *
 * Does not own: the actual worker spawn (spawn-broker.ts on the
 * orchestrator side), session-id persistence (runner.ts), or any
 * direct contact with `@moltzap/runtimes` (this process never imports
 * it; it speaks HTTP to the orchestrator only).
 *
 * Trust boundary: receives `ZAPBOT_ORCHESTRATOR_URL` and
 * `ZAPBOT_SPAWN_SECRET` from env, set by the orchestrator when it
 * wrote `.mcp.json` at boot. Never logs the secret. Never accepts
 * MCP calls from outside the spawning lead claude process — stdio
 * transport is naturally peer-scoped (same parent PID).
 */

import { Effect } from "effect";
import type { OrchestratorError } from "../src/orchestrator/errors.ts";
import type {
  SpawnWorkerRequest,
  SpawnWorkerResponse,
} from "../src/orchestrator/spawn-broker.ts";

// ── Public shapes ───────────────────────────────────────────────────

/**
 * MCP tool definition body. Returned by the registration helper so the
 * stdio server can advertise it on `tools/list`. The shape matches
 * `@modelcontextprotocol/sdk`'s `Tool` type but is reproduced here so
 * the stub does not pin a specific SDK version on `main`.
 */
export interface RequestWorkerSpawnToolDescriptor {
  readonly name: "request_worker_spawn";
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/**
 * Env vars the process expects from its parent (the orchestrator-issued
 * `.mcp.json`). Decoded once at boot; failure to decode exits the
 * process with status 1 and an error on stderr (the lead claude
 * session surfaces the failure to the user as an MCP-server-startup
 * error, which is the correct operator-visible signal).
 */
export interface SpawnMcpEnv {
  readonly orchestratorUrl: string;
  readonly spawnSecret: string;
}

// ── DI seam ─────────────────────────────────────────────────────────

export interface SpawnMcpDeps {
  readonly env: SpawnMcpEnv;
  readonly fetch: (
    url: string,
    init: {
      readonly method: "POST";
      readonly headers: Readonly<Record<string, string>>;
      readonly body: string;
    },
  ) => Effect.Effect<
    {
      readonly status: number;
      readonly body: string;
    },
    OrchestratorError,
    never
  >;
  readonly log: (
    level: "info" | "warn" | "error",
    msg: string,
    extra?: Record<string, unknown>,
  ) => void;
}

// ── Public surface ──────────────────────────────────────────────────

/**
 * Boot the MCP stdio server. Registers the `request_worker_spawn`
 * tool, then listens forever on stdin/stdout. Resolves never on the
 * happy path; fails with `OrchestratorError` if env decode fails
 * before the transport is up.
 */
export function runSpawnMcpProcess(
  env: NodeJS.ProcessEnv,
): Effect.Effect<never, OrchestratorError, never> {
  void env;
  throw new Error("not implemented: runSpawnMcpProcess");
}

/**
 * Forward one `request_worker_spawn` call to the orchestrator's
 * `POST /spawn` endpoint. Lifted out of the MCP transport handler so
 * unit tests can drive it without an MCP harness.
 */
export function forwardSpawnRequest(
  request: SpawnWorkerRequest,
  deps: SpawnMcpDeps,
): Effect.Effect<SpawnWorkerResponse, OrchestratorError, never> {
  void request;
  void deps;
  throw new Error("not implemented: forwardSpawnRequest");
}

/**
 * Pure descriptor for the MCP tool. Pinned in code so the lead
 * session sees a stable shape regardless of SDK version drift.
 * Implementer (sub-issue #3) fills in the JSON Schema for
 * `SpawnWorkerRequest` here.
 */
export function describeRequestWorkerSpawnTool(): RequestWorkerSpawnToolDescriptor {
  throw new Error("not implemented: describeRequestWorkerSpawnTool");
}
