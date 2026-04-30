/**
 * orchestrator/dispatcher — Effect-native HTTP POST to the orchestrator's
 * `/turn` endpoint with shared-secret bearer auth (epic #369 D2/D3,
 * sub-issue #375).
 *
 * Owns: the bridge's network seam to the orchestrator process. Builds the
 * request body, attaches the bearer header, and schema-decodes the JSON
 * response into either `TurnSuccessResponse` (200) or `OrchestratorError`
 * (4xx/5xx body). Network failures and unrecognised response bodies are
 * surfaced as `OrchestratorUnreachable` so the bridge has a single
 * "orchestrator process is misbehaving" tag for operator diagnostics.
 *
 * Does not own: webhook classification, prompt rendering, or
 * `OrchestratorError` → HTTP response mapping (that lives in the bridge's
 * fetch handler). Mirrors `src/orchestrator/runner.ts`'s Effect-only
 * shape so the bridge can compose them with one `Effect.runPromise` at
 * the webhook handler seam.
 */

import { Effect, Schema } from "effect";
import type { OrchestratorError } from "./errors.ts";
import type { TurnSuccessResponse } from "./server.ts";

// ── Public shapes ───────────────────────────────────────────────────

export interface DispatchTurnRequest {
  readonly projectSlug: string;
  readonly deliveryId: string;
  readonly message: string;
  readonly githubToken: string;
}

/**
 * DI seam. `fetch` is injected so tests drive the dispatcher without a
 * live HTTP listener; production wiring passes `globalThis.fetch`.
 */
export interface DispatcherDeps {
  readonly orchestratorUrl: string;
  readonly orchestratorSecret: string;
  readonly fetch: typeof globalThis.fetch;
}

// ── Response schemas ────────────────────────────────────────────────
// Mirror the orchestrator's `renderErrorResponse` (server.ts); a decode
// miss downgrades to `OrchestratorUnreachable` rather than guessing.

const RepliedSchema = Schema.Struct({
  tag: Schema.Literal("Replied"),
  newSessionId: Schema.NonEmptyString,
  durationMs: Schema.Number,
});

const DuplicateDeliverySchema = Schema.Struct({
  tag: Schema.Literal("DuplicateDelivery"),
  priorSessionId: Schema.NonEmptyString,
});

const TurnSuccessSchema = Schema.Union(RepliedSchema, DuplicateDeliverySchema);

const ReasonStringSchema = Schema.Struct({
  error: Schema.NonEmptyString,
  reason: Schema.String,
});

const AuthFailedSchema = Schema.Struct({
  error: Schema.Literal("OrchestratorAuthFailed"),
  reason: Schema.Literal("missing-header", "secret-mismatch"),
});

const LockTimeoutSchema = Schema.Struct({
  error: Schema.Literal("LockTimeout"),
  projectSlug: Schema.String,
  waitedMs: Schema.Number,
});

const LeadSessionCorruptedSchema = Schema.Struct({
  error: Schema.Literal("LeadSessionCorrupted"),
  projectSlug: Schema.String,
  sessionPath: Schema.String,
  reason: Schema.String,
});

const LeadProcessFailedSchema = Schema.Struct({
  error: Schema.Literal("LeadProcessFailed"),
  projectSlug: Schema.String,
  exitCode: Schema.Union(Schema.Number, Schema.Null),
  stderrTail: Schema.String,
});

const FleetSpawnFailedSchema = Schema.Struct({
  error: Schema.Literal("FleetSpawnFailed"),
  agentName: Schema.String,
  cause: Schema.Literal("ready-timeout", "process-exited", "config-invalid"),
  detail: Schema.String,
});

const ProjectDirMissingSchema = Schema.Struct({
  error: Schema.Literal("ProjectDirMissing"),
  projectSlug: Schema.String,
  path: Schema.String,
});

const GitFetchFailedSchema = Schema.Struct({
  error: Schema.Literal("GitFetchFailed"),
  projectSlug: Schema.String,
  stderrTail: Schema.String,
});

const ProjectCheckoutFailedSchema = Schema.Struct({
  error: Schema.Literal("ProjectCheckoutFailed"),
  projectSlug: Schema.String,
  stage: Schema.Literal("clone", "worktree-add", "fetch"),
  stderrTail: Schema.String,
});

const McpConfigWriteFailedSchema = Schema.Struct({
  error: Schema.Literal("McpConfigWriteFailed"),
  projectSlug: Schema.String,
  path: Schema.String,
  cause: Schema.String,
});

const OrchestratorUnreachableSchema = Schema.Struct({
  error: Schema.Literal("OrchestratorUnreachable"),
  url: Schema.String,
  cause: Schema.String,
});

const BootConfigInvalidSchema = Schema.Struct({
  error: Schema.Literal("BootConfigInvalid"),
  source: Schema.Literal("config.json", "projects.json", "moltzap-paths"),
  path: Schema.String,
  reason: Schema.String,
});

// ── Public surface ──────────────────────────────────────────────────

/**
 * POST `<orchestratorUrl>/turn` with bearer auth and schema-decoded body.
 *
 * Success path: 200 → decoded `TurnSuccessResponse`.
 *
 * Error mapping:
 *   - Network/DNS/TLS failure → `OrchestratorUnreachable`.
 *   - Non-JSON or non-decodable body → `OrchestratorUnreachable` with a
 *     descriptive cause (the orchestrator returned something we cannot
 *     trust as a typed error).
 *   - 4xx/5xx with a recognised `error` tag → corresponding
 *     `OrchestratorError` variant.
 */
export function runTurn(
  deps: DispatcherDeps,
  request: DispatchTurnRequest,
): Effect.Effect<TurnSuccessResponse, OrchestratorError, never> {
  const url = `${deps.orchestratorUrl.replace(/\/+$/u, "")}/turn`;
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        deps.fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${deps.orchestratorSecret}`,
          },
          body: JSON.stringify(request),
        }),
      catch: (cause): OrchestratorError => ({
        _tag: "OrchestratorUnreachable",
        url,
        cause: cause instanceof Error ? cause.message : String(cause),
      }),
    });

    const parsed = yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: (cause): OrchestratorError => ({
        _tag: "OrchestratorUnreachable",
        url,
        cause: `response body read/parse failed (status=${response.status}): ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
    });

    if (response.ok) {
      return yield* decodeTurnSuccess(parsed, response.status, url);
    }
    return yield* decodeErrorBody(parsed, response.status, url);
  });
}

// ── Internals ───────────────────────────────────────────────────────

function decodeTurnSuccess(
  parsed: unknown,
  status: number,
  url: string,
): Effect.Effect<TurnSuccessResponse, OrchestratorError, never> {
  return Effect.try({
    try: (): TurnSuccessResponse => {
      const decoded = Schema.decodeUnknownSync(TurnSuccessSchema)(parsed);
      return decoded as TurnSuccessResponse;
    },
    catch: (cause): OrchestratorError => ({
      _tag: "OrchestratorUnreachable",
      url,
      cause: `2xx response did not match TurnSuccessResponse schema (status=${status}): ${cause instanceof Error ? cause.message : String(cause)}`,
    }),
  });
}

/**
 * Translate the orchestrator's JSON error body into the matching
 * `OrchestratorError` tag. An unrecognised `error` field downgrades to
 * `OrchestratorUnreachable` so the bridge has a single fall-through tag
 * for "orchestrator behaviour we don't know how to type-check yet."
 */
function decodeErrorBody(
  parsed: unknown,
  status: number,
  url: string,
): Effect.Effect<never, OrchestratorError, never> {
  const tag = readErrorTag(parsed);
  if (tag === null) {
    return Effect.fail<OrchestratorError>({
      _tag: "OrchestratorUnreachable",
      url,
      cause: `response (status=${status}) had no recognisable 'error' field: ${truncate(JSON.stringify(parsed))}`,
    });
  }
  const error = decodeKnownError(parsed, tag, status, url);
  return Effect.fail(error);
}

function readErrorTag(parsed: unknown): string | null {
  if (parsed === null || typeof parsed !== "object") return null;
  const errorField = (parsed as { readonly error?: unknown }).error;
  return typeof errorField === "string" && errorField.length > 0 ? errorField : null;
}

function decodeKnownError(
  parsed: unknown,
  tag: string,
  status: number,
  url: string,
): OrchestratorError {
  switch (tag) {
    case "OrchestratorAuthFailed": {
      const decoded = trySchema(AuthFailedSchema, parsed);
      if (decoded === null) return wrap(`OrchestratorAuthFailed body shape invalid`, status, url, parsed);
      return { _tag: "OrchestratorAuthFailed", reason: decoded.reason };
    }
    case "TurnRequestInvalid": {
      const decoded = trySchema(ReasonStringSchema, parsed);
      if (decoded === null) return wrap(`TurnRequestInvalid body shape invalid`, status, url, parsed);
      return { _tag: "TurnRequestInvalid", reason: decoded.reason };
    }
    case "SpawnRequestInvalid": {
      const decoded = trySchema(ReasonStringSchema, parsed);
      if (decoded === null) return wrap(`SpawnRequestInvalid body shape invalid`, status, url, parsed);
      return { _tag: "SpawnRequestInvalid", reason: decoded.reason };
    }
    case "LockTimeout": {
      const decoded = trySchema(LockTimeoutSchema, parsed);
      if (decoded === null) return wrap(`LockTimeout body shape invalid`, status, url, parsed);
      return {
        _tag: "LockTimeout",
        projectSlug: decoded.projectSlug,
        waitedMs: decoded.waitedMs,
      };
    }
    case "LeadSessionCorrupted": {
      const decoded = trySchema(LeadSessionCorruptedSchema, parsed);
      if (decoded === null) return wrap(`LeadSessionCorrupted body shape invalid`, status, url, parsed);
      return {
        _tag: "LeadSessionCorrupted",
        projectSlug: decoded.projectSlug,
        sessionPath: decoded.sessionPath,
        reason: decoded.reason,
      };
    }
    case "LeadProcessFailed": {
      const decoded = trySchema(LeadProcessFailedSchema, parsed);
      if (decoded === null) return wrap(`LeadProcessFailed body shape invalid`, status, url, parsed);
      return {
        _tag: "LeadProcessFailed",
        projectSlug: decoded.projectSlug,
        exitCode: decoded.exitCode,
        stderrTail: decoded.stderrTail,
      };
    }
    case "FleetSpawnFailed": {
      const decoded = trySchema(FleetSpawnFailedSchema, parsed);
      if (decoded === null) return wrap(`FleetSpawnFailed body shape invalid`, status, url, parsed);
      return {
        _tag: "FleetSpawnFailed",
        agentName: decoded.agentName,
        cause: decoded.cause,
        detail: decoded.detail,
      };
    }
    case "ProjectDirMissing": {
      const decoded = trySchema(ProjectDirMissingSchema, parsed);
      if (decoded === null) return wrap(`ProjectDirMissing body shape invalid`, status, url, parsed);
      return {
        _tag: "ProjectDirMissing",
        projectSlug: decoded.projectSlug,
        path: decoded.path,
      };
    }
    case "GitFetchFailed": {
      const decoded = trySchema(GitFetchFailedSchema, parsed);
      if (decoded === null) return wrap(`GitFetchFailed body shape invalid`, status, url, parsed);
      return {
        _tag: "GitFetchFailed",
        projectSlug: decoded.projectSlug,
        stderrTail: decoded.stderrTail,
      };
    }
    case "ProjectCheckoutFailed": {
      const decoded = trySchema(ProjectCheckoutFailedSchema, parsed);
      if (decoded === null) return wrap(`ProjectCheckoutFailed body shape invalid`, status, url, parsed);
      return {
        _tag: "ProjectCheckoutFailed",
        projectSlug: decoded.projectSlug,
        stage: decoded.stage,
        stderrTail: decoded.stderrTail,
      };
    }
    case "McpConfigWriteFailed": {
      const decoded = trySchema(McpConfigWriteFailedSchema, parsed);
      if (decoded === null) return wrap(`McpConfigWriteFailed body shape invalid`, status, url, parsed);
      return {
        _tag: "McpConfigWriteFailed",
        projectSlug: decoded.projectSlug,
        path: decoded.path,
        cause: decoded.cause,
      };
    }
    case "OrchestratorUnreachable": {
      const decoded = trySchema(OrchestratorUnreachableSchema, parsed);
      if (decoded === null) return wrap(`OrchestratorUnreachable body shape invalid`, status, url, parsed);
      return { _tag: "OrchestratorUnreachable", url: decoded.url, cause: decoded.cause };
    }
    case "BootConfigInvalid": {
      const decoded = trySchema(BootConfigInvalidSchema, parsed);
      if (decoded === null) return wrap(`BootConfigInvalid body shape invalid`, status, url, parsed);
      return {
        _tag: "BootConfigInvalid",
        source: decoded.source,
        path: decoded.path,
        reason: decoded.reason,
      };
    }
    default:
      return wrap(`unrecognised error tag '${tag}'`, status, url, parsed);
  }
}

function trySchema<A, I>(
  schema: Schema.Schema<A, I>,
  parsed: unknown,
): A | null {
  try {
    return Schema.decodeUnknownSync(schema)(parsed);
  } catch (cause) {
    void cause;
    return null;
  }
}

function wrap(
  reason: string,
  status: number,
  url: string,
  parsed: unknown,
): OrchestratorError {
  return {
    _tag: "OrchestratorUnreachable",
    url,
    cause: `${reason} (status=${status}): ${truncate(JSON.stringify(parsed))}`,
  };
}

function truncate(text: string): string {
  return text.length > 256 ? `${text.slice(0, 256)}...` : text;
}
