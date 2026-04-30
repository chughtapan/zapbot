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
 * the orchestrator's response back over MCP.
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

import { Effect, Schema } from "effect";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { asRepoFullName } from "../src/types.ts";
import { describeOrchestratorError } from "../src/orchestrator/errors.ts";
import type { OrchestratorError } from "../src/orchestrator/errors.ts";
import {
  type GithubInstallationToken,
  type SpawnWorkerRequest,
  type SpawnWorkerResponse,
} from "../src/orchestrator/spawn-broker.ts";

// ── Local types ─────────────────────────────────────────────────────

interface ToolResult {
  readonly isError?: boolean;
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
}

/**
 * Narrow projection of the MCP SDK's `McpServer.registerTool` shape used
 * by this module. The SDK's published type uses zod-shape generics that
 * do not compose cleanly with the hand-rolled JSON Schema descriptor
 * exposed here, so we model only the fields we actually call. The
 * callback's return type is `unknown` so an Effect-bridged adapter can
 * pass an async function in without naming `Promise` here (CLAUDE.md
 * §promise-type/async-keyword caps).
 */
interface McpServerLike {
  registerTool(
    name: string,
    config: {
      readonly description: string;
      readonly inputSchema?: undefined;
      readonly annotations: { readonly inputSchema: Readonly<Record<string, unknown>> };
    },
    cb: (rawInput: unknown) => unknown,
  ): unknown;
}

// ── Public shapes ───────────────────────────────────────────────────

export interface RequestWorkerSpawnToolDescriptor {
  readonly name: "request_worker_spawn";
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

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

// ── Schemas ─────────────────────────────────────────────────────────

const SpawnEnvSchema = Schema.Struct({
  ZAPBOT_ORCHESTRATOR_URL: Schema.NonEmptyString,
  ZAPBOT_SPAWN_SECRET: Schema.NonEmptyString,
});

const ToolInputSchema = Schema.Struct({
  repo: Schema.NonEmptyString,
  issue: Schema.optional(Schema.Union(Schema.Number, Schema.Null)),
  prompt: Schema.NonEmptyString,
  workerSlug: Schema.NonEmptyString,
  githubToken: Schema.NonEmptyString,
  worktreePath: Schema.NonEmptyString,
});

const SpawnResponseSchema = Schema.Struct({
  tag: Schema.Literal("Spawned"),
  agentId: Schema.NonEmptyString,
  worktreePath: Schema.NonEmptyString,
});

function decodeEnv(env: NodeJS.ProcessEnv): SpawnMcpEnv {
  const decoded = Schema.decodeUnknownSync(SpawnEnvSchema)({
    ZAPBOT_ORCHESTRATOR_URL: env.ZAPBOT_ORCHESTRATOR_URL,
    ZAPBOT_SPAWN_SECRET: env.ZAPBOT_SPAWN_SECRET,
  });
  return {
    orchestratorUrl: decoded.ZAPBOT_ORCHESTRATOR_URL,
    spawnSecret: decoded.ZAPBOT_SPAWN_SECRET,
  };
}

function decodeToolInput(raw: unknown): SpawnWorkerRequest {
  const decoded = Schema.decodeUnknownSync(ToolInputSchema)(raw);
  return {
    repo: asRepoFullName(decoded.repo),
    issue: decoded.issue ?? null,
    prompt: decoded.prompt,
    workerSlug: decoded.workerSlug,
    githubToken: decoded.githubToken as GithubInstallationToken,
    worktreePath: decoded.worktreePath,
  };
}

// ── Public surface ──────────────────────────────────────────────────

export function describeRequestWorkerSpawnTool(): RequestWorkerSpawnToolDescriptor {
  return {
    name: "request_worker_spawn",
    description:
      "Spawn a Claude Code worker session in an isolated worktree. Use when the work is parallelizable, takes >5 min, or needs its own GitHub-side artifact (PR / issue comment) to land. The caller (lead session) computes the worktree path and passes it here; binding the adapter to that path is upstream work, so for now `worktreePath` is informational only and the worker runs in the adapter's allocated state dir.",
    inputSchema: {
      type: "object",
      required: ["repo", "prompt", "workerSlug", "githubToken", "worktreePath"],
      properties: {
        repo: { type: "string", description: "owner/name" },
        issue: { type: ["integer", "null"] },
        prompt: { type: "string" },
        workerSlug: { type: "string", description: "used in the worktree path" },
        githubToken: { type: "string" },
        worktreePath: {
          type: "string",
          description:
            "absolute path to the per-worker git worktree (computed by the lead session; informational only — the adapter does not yet bind cwd to it)",
        },
      },
    },
  };
}

/**
 * Forward one `request_worker_spawn` call to the orchestrator's
 * `POST /spawn` endpoint.
 */
export function forwardSpawnRequest(
  request: SpawnWorkerRequest,
  deps: SpawnMcpDeps,
): Effect.Effect<SpawnWorkerResponse, OrchestratorError, never> {
  return Effect.gen(function* () {
    const url = `${deps.env.orchestratorUrl}/spawn`;
    const body = JSON.stringify({
      repo: request.repo,
      issue: request.issue,
      prompt: request.prompt,
      workerSlug: request.workerSlug,
      githubToken: request.githubToken,
      worktreePath: request.worktreePath,
    });

    const response = yield* deps.fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${deps.env.spawnSecret}`,
      },
      body,
    });

    if (response.status === 401 || response.status === 403) {
      const reason = parseErrorReason(response.body) ?? "secret-mismatch";
      return yield* Effect.fail<OrchestratorError>({
        _tag: "OrchestratorAuthFailed",
        reason: reason === "missing-header" ? "missing-header" : "secret-mismatch",
      });
    }

    if (response.status >= 500) {
      return yield* Effect.fail<OrchestratorError>(
        decodeServerErrorBody(response.body, request.workerSlug),
      );
    }

    if (response.status === 422) {
      return yield* Effect.fail<OrchestratorError>({
        _tag: "SpawnRequestInvalid",
        reason: parseErrorReason(response.body) ?? "schema decode failed",
      });
    }

    if (response.status !== 200) {
      return yield* Effect.fail<OrchestratorError>({
        _tag: "OrchestratorUnreachable",
        url,
        cause: `unexpected HTTP status ${response.status}`,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch (cause) {
      return yield* Effect.fail<OrchestratorError>({
        _tag: "OrchestratorUnreachable",
        url,
        cause: `response body parse failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    }

    let decoded: Schema.Schema.Type<typeof SpawnResponseSchema>;
    try {
      decoded = Schema.decodeUnknownSync(SpawnResponseSchema)(parsed);
    } catch (cause) {
      return yield* Effect.fail<OrchestratorError>({
        _tag: "OrchestratorUnreachable",
        url,
        cause: `response shape mismatch: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    }

    return {
      _tag: "Spawned" as const,
      agentId: decoded.agentId as SpawnWorkerResponse["agentId"],
      worktreePath: decoded.worktreePath,
    };
  });
}

function parseErrorReason(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { readonly reason?: unknown };
    return typeof parsed.reason === "string" ? parsed.reason : null;
  } catch (cause) {
    // Body is opaque to us; the bridge-visible signal is the HTTP
    // status code, not this error envelope's reason field.
    void cause;
    return null;
  }
}

function decodeServerErrorBody(body: string, workerSlug: string): OrchestratorError {
  try {
    const parsed = JSON.parse(body) as {
      readonly error?: unknown;
      readonly cause?: unknown;
      readonly detail?: unknown;
    };
    if (typeof parsed.error === "string" && parsed.error === "FleetSpawnFailed") {
      return {
        _tag: "FleetSpawnFailed",
        agentName: workerSlug,
        cause:
          parsed.cause === "ready-timeout" ||
          parsed.cause === "process-exited" ||
          parsed.cause === "config-invalid"
            ? parsed.cause
            : "config-invalid",
        detail: typeof parsed.detail === "string" ? parsed.detail : "(no detail)",
      };
    }
  } catch (cause) {
    // Non-JSON 5xx body — fall through to OrchestratorUnreachable below.
    void cause;
  }
  return {
    _tag: "OrchestratorUnreachable",
    url: "/spawn",
    cause: body.slice(0, 200),
  };
}

/**
 * Boot the MCP stdio server. Registers the `request_worker_spawn`
 * tool, then listens forever on stdin/stdout. Resolves never on the
 * happy path; fails with `OrchestratorError` if env decode fails
 * before the transport is up.
 */
export function runSpawnMcpProcess(
  rawEnv: NodeJS.ProcessEnv,
): Effect.Effect<never, OrchestratorError, never> {
  return Effect.gen(function* () {
    const env = yield* Effect.try({
      try: () => decodeEnv(rawEnv),
      catch: (cause): OrchestratorError => ({
        _tag: "SpawnRequestInvalid",
        reason: `env decode failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
    });

    const deps: SpawnMcpDeps = {
      env,
      fetch: defaultFetch,
      log: (level, msg, extra) => {
        // stderr only — stdout is reserved for MCP transport.
        process.stderr.write(
          `[zapbot-spawn-mcp] ${level} ${msg}${extra ? ` ${JSON.stringify(extra)}` : ""}\n`,
        );
      },
    };

    const descriptor = describeRequestWorkerSpawnTool();
    const server = new McpServer(
      { name: "zapbot-spawn", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );

    (server as unknown as McpServerLike).registerTool(
      descriptor.name,
      {
        description: descriptor.description,
        inputSchema: undefined,
        annotations: {
          inputSchema: descriptor.inputSchema,
        },
      },
      (rawInput: unknown) => Effect.runPromise(handleToolCall(rawInput, deps)),
    );

    const transport = new StdioServerTransport();
    yield* Effect.tryPromise({
      try: () => server.connect(transport),
      catch: (cause): OrchestratorError => ({
        _tag: "OrchestratorUnreachable",
        url: deps.env.orchestratorUrl,
        cause: `MCP transport boot failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
    });

    // Park forever; the SDK's transport handles inbound messages.
    return yield* Effect.never;
  });
}

/**
 * Effect-native handler for one `request_worker_spawn` MCP call. Decodes
 * the raw input, forwards it to the orchestrator's `/spawn` endpoint,
 * and renders the tool response (success or error) into the SDK's
 * `ToolResult` shape.
 */
function handleToolCall(
  rawInput: unknown,
  deps: SpawnMcpDeps,
): Effect.Effect<ToolResult, never, never> {
  return Effect.suspend(() => {
    let request: SpawnWorkerRequest;
    try {
      request = decodeToolInput(rawInput);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      return Effect.succeed<ToolResult>({
        isError: true,
        content: [
          {
            type: "text",
            text: describeOrchestratorError({
              _tag: "SpawnRequestInvalid",
              reason,
            }),
          },
        ],
      });
    }
    return forwardSpawnRequest(request, deps).pipe(
      Effect.match({
        onSuccess: (response): ToolResult => ({
          content: [
            {
              type: "text",
              text: JSON.stringify(response),
            },
          ],
        }),
        onFailure: (error): ToolResult => ({
          isError: true,
          content: [
            {
              type: "text",
              text: describeOrchestratorError(error),
            },
          ],
        }),
      }),
    );
  });
}

function defaultFetch(
  url: string,
  init: {
    readonly method: "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  },
): Effect.Effect<{ readonly status: number; readonly body: string }, OrchestratorError, never> {
  const wrapFetchError = (cause: unknown): OrchestratorError => ({
    _tag: "OrchestratorUnreachable",
    url,
    cause: cause instanceof Error ? cause.message : String(cause),
  });
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(url, {
          method: init.method,
          headers: init.headers as Record<string, string>,
          body: init.body,
        }),
      catch: wrapFetchError,
    });
    const body = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: wrapFetchError,
    });
    return { status: response.status, body };
  });
}

// ── Top-level shim ──────────────────────────────────────────────────

if (import.meta.main) {
  process.on("unhandledRejection", (cause) => {
    process.stderr.write(
      `[zapbot-spawn-mcp] Unhandled rejection (non-fatal): ${
        cause instanceof Error ? cause.message : String(cause)
      }\n`,
    );
  });
  Effect.runPromise(runSpawnMcpProcess(process.env)).catch((cause: unknown) => {
    process.stderr.write(
      `[zapbot-spawn-mcp] Fatal: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
    process.exit(1);
  });
}
