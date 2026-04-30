/**
 * orchestrator/server — HTTP listener for `POST /turn`, `POST /spawn`,
 * `GET /healthz` (epic #369 D2, D3).
 *
 * Owns: HTTP transport, shared-secret auth-header check, schema decode
 * of request bodies, dispatch into `runner.runTurn` and
 * `spawnBroker.requestWorkerSpawn`, mapping of `OrchestratorError` to
 * HTTP status + JSON body.
 *
 * Does not own: claude subprocess (runner.ts), worker spawn fleet
 * (spawn-broker.ts), MCP transport (bin/zapbot-spawn-mcp.ts is a
 * separate stdio process spawned by the lead claude session that
 * forwards `request_worker_spawn` calls to this server's `/spawn`).
 */

import { Cause, Effect, Schema } from "effect";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  asDeliveryId,
  asRepoFullName,
  type RepoFullName,
} from "../types.ts";
import { absurd } from "../types.ts";
import type { OrchestratorError } from "./errors.ts";
import {
  asProjectSlug,
  runTurn,
  type ProjectSlug,
  type RunnerDeps,
  type TurnRequest,
  type TurnResponse,
} from "./runner.ts";
import {
  type SpawnBrokerHandle,
  type SpawnWorkerRequest,
  type SpawnWorkerResponse,
  type GithubInstallationToken,
} from "./spawn-broker.ts";

// ── Branded identifiers ─────────────────────────────────────────────

export type SharedSecret = string & { readonly __brand: "SharedSecret" };
export type HttpPort = number & { readonly __brand: "HttpPort" };

export function asSharedSecret(s: string): SharedSecret {
  return s as SharedSecret;
}
export function asHttpPort(n: number): HttpPort {
  return n as HttpPort;
}

// ── Public shapes ───────────────────────────────────────────────────

export interface HttpServerHandle {
  readonly port: HttpPort;
  readonly close: () => Effect.Effect<void, never, never>;
}

export const AUTH_HEADER_PREFIX = "Bearer ";

export interface TurnEndpointContract {
  readonly request: TurnRequest;
  readonly response: TurnResponse;
}

/**
 * Discriminated union for `POST /turn` 200 responses (wire shape; the
 * runner's `TurnResponse` is the in-process Effect-channel sibling).
 *
 * - `Replied`: lead session resumed and produced output. `newSessionId`
 *   is the new claude session id; `durationMs` is wall-clock turn time.
 * - `DuplicateDelivery`: the incoming `deliveryId` matched the
 *   persisted `lastDeliveryId`; idempotency short-circuits the run
 *   without re-invoking claude. `priorSessionId` echoes the existing
 *   session.
 *
 * `writeTurnExit` projects `TurnResponse` into this shape; the bridge
 * decodes the same union on the receiving end.
 */
export type TurnSuccessResponse =
  | { readonly tag: "Replied"; readonly newSessionId: string; readonly durationMs: number }
  | { readonly tag: "DuplicateDelivery"; readonly priorSessionId: string };

export interface SpawnEndpointContract {
  readonly request: SpawnWorkerRequest;
  readonly response: SpawnWorkerResponse;
}

export interface HealthzResponse {
  readonly ok: boolean;
  readonly port: HttpPort;
  readonly projects: number;
}

// ── DI seam ─────────────────────────────────────────────────────────

export interface ServerDeps {
  readonly secret: SharedSecret;
  readonly port: HttpPort;
  readonly runnerDeps: RunnerDeps;
  readonly broker: SpawnBrokerHandle;
  readonly projectsCount: () => number;
  readonly log: (
    level: "info" | "warn" | "error",
    msg: string,
    extra?: Record<string, unknown>,
  ) => void;
}

// ── Schemas (Principle 2: every HTTP body is schema-decoded) ────────

const TurnRequestSchema = Schema.Struct({
  projectSlug: Schema.NonEmptyString,
  deliveryId: Schema.NonEmptyString,
  message: Schema.String,
  githubToken: Schema.NonEmptyString,
});

const SpawnRequestSchema = Schema.Struct({
  repo: Schema.NonEmptyString,
  issue: Schema.Union(Schema.Number, Schema.Null),
  prompt: Schema.String,
  workerSlug: Schema.NonEmptyString,
  githubToken: Schema.NonEmptyString,
  worktreePath: Schema.NonEmptyString,
});

function decodeTurnRequest(raw: unknown): TurnRequest {
  const decoded = Schema.decodeUnknownSync(TurnRequestSchema)(raw);
  return {
    projectSlug: asProjectSlug(decoded.projectSlug),
    deliveryId: asDeliveryId(decoded.deliveryId),
    message: decoded.message,
    githubToken: decoded.githubToken as GithubInstallationToken,
  };
}

function decodeSpawnRequest(raw: unknown): SpawnWorkerRequest {
  const decoded = Schema.decodeUnknownSync(SpawnRequestSchema)(raw);
  return {
    repo: asRepoFullName(decoded.repo),
    issue: decoded.issue,
    prompt: decoded.prompt,
    workerSlug: decoded.workerSlug,
    githubToken: decoded.githubToken as GithubInstallationToken,
    worktreePath: decoded.worktreePath,
  };
}

// ── Public surface ──────────────────────────────────────────────────

export function startOrchestratorServer(
  deps: ServerDeps,
): Effect.Effect<HttpServerHandle, OrchestratorError, never> {
  return Effect.async<HttpServerHandle, OrchestratorError, never>((resume) => {
    let draining = false;

    const server: Server = createServer((req, res) => {
      Effect.runFork(
        dispatchHttp(req, res, deps, () => draining).pipe(
          Effect.catchAllCause((cause) =>
            Effect.sync(() => {
              deps.log("error", "server: dispatch crashed", {
                cause: Cause.pretty(cause),
              });
              if (!res.headersSent) {
                sendJson(res, 500, { error: "InternalError" });
              }
            }),
          ),
        ),
      );
    });

    server.on("error", (cause: Error) => {
      resume(
        Effect.fail<OrchestratorError>({
          _tag: "OrchestratorUnreachable",
          url: `http://127.0.0.1:${deps.port}`,
          cause: cause.message,
        }),
      );
    });

    server.listen(deps.port, "127.0.0.1", () => {
      const address = server.address();
      const boundPort: HttpPort =
        typeof address === "object" && address !== null && "port" in address
          ? (address.port as HttpPort)
          : deps.port;
      deps.log("info", "server: listening", { port: boundPort });
      const handle: HttpServerHandle = {
        port: boundPort,
        close: () =>
          Effect.async<void, never, never>((closeResume) => {
            draining = true;
            server.close(() => {
              closeResume(Effect.void);
            });
          }),
      };
      resume(Effect.succeed(handle));
    });
  });
}

/**
 * Render an `OrchestratorError` to a `{ status, body }` HTTP response.
 * Pure function; no I/O.
 */
export function renderErrorResponse(error: OrchestratorError): {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
} {
  switch (error._tag) {
    case "OrchestratorAuthFailed":
      return { status: 401, body: { error: error._tag, reason: error.reason } };
    case "TurnRequestInvalid":
      return { status: 422, body: { error: error._tag, reason: error.reason } };
    case "SpawnRequestInvalid":
      return { status: 422, body: { error: error._tag, reason: error.reason } };
    case "LockTimeout":
      return {
        status: 429,
        body: { error: error._tag, projectSlug: error.projectSlug, waitedMs: error.waitedMs },
      };
    case "LeadSessionCorrupted":
      return {
        status: 503,
        body: {
          error: error._tag,
          projectSlug: error.projectSlug,
          sessionPath: error.sessionPath,
          reason: error.reason,
        },
      };
    case "LeadProcessFailed":
      return {
        status: 503,
        body: {
          error: error._tag,
          projectSlug: error.projectSlug,
          exitCode: error.exitCode,
          stderrTail: error.stderrTail,
        },
      };
    case "FleetSpawnFailed":
      return {
        status: 503,
        body: {
          error: error._tag,
          agentName: error.agentName,
          cause: error.cause,
          detail: error.detail,
        },
      };
    case "ProjectDirMissing":
      return {
        status: 503,
        body: { error: error._tag, projectSlug: error.projectSlug, path: error.path },
      };
    case "GitFetchFailed":
      return {
        status: 503,
        body: { error: error._tag, projectSlug: error.projectSlug, stderrTail: error.stderrTail },
      };
    case "ProjectCheckoutFailed":
      return {
        status: 503,
        body: {
          error: error._tag,
          projectSlug: error.projectSlug,
          stage: error.stage,
          stderrTail: error.stderrTail,
        },
      };
    case "McpConfigWriteFailed":
      return {
        status: 503,
        body: {
          error: error._tag,
          projectSlug: error.projectSlug,
          path: error.path,
          cause: error.cause,
        },
      };
    case "OrchestratorUnreachable":
      return { status: 503, body: { error: error._tag, url: error.url, cause: error.cause } };
    case "BootConfigInvalid":
      // Boot-time errors are fatal at process start; the entrypoint
      // exits non-zero before the listener binds. If one ever reaches
      // the HTTP renderer (e.g. a future runtime-config-reload path),
      // surface it as 503 so the bridge maps it through
      // OrchestratorUnreachable's existing diagnostic chain.
      return {
        status: 503,
        body: {
          error: error._tag,
          source: error.source,
          path: error.path,
          reason: error.reason,
        },
      };
    default:
      return absurd(error);
  }
}

// ── Dispatch (Effect-native) ────────────────────────────────────────

function dispatchHttp(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  isDraining: () => boolean,
): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    const url = req.url ?? "";
    const method = (req.method ?? "GET").toUpperCase();

    if (method === "GET" && url === "/healthz") {
      if (isDraining()) {
        sendJson(res, 503, { ok: false });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        port: deps.port,
        projects: deps.projectsCount(),
      });
      return;
    }

    if (method !== "POST" || (url !== "/turn" && url !== "/spawn")) {
      sendJson(res, 404, { error: "NotFound" });
      return;
    }

    const authResult = checkAuth(req, deps.secret);
    if (authResult._tag === "Err") {
      writeError(res, authResult.error);
      return;
    }

    const bodyText = yield* readBody(req).pipe(
      Effect.map((value): string | null => value),
      Effect.catchAll(() => Effect.succeed<string | null>(null)),
    );
    if (bodyText === null) {
      sendJson(res, 400, { error: "BodyReadFailed" });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch (cause) {
      writeError(res, {
        _tag: "TurnRequestInvalid",
        reason: `JSON parse failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
      return;
    }

    if (url === "/turn") {
      let request: TurnRequest;
      try {
        request = decodeTurnRequest(parsed);
      } catch (cause) {
        writeError(res, {
          _tag: "TurnRequestInvalid",
          reason: cause instanceof Error ? cause.message : String(cause),
        });
        return;
      }
      const exit = yield* Effect.exit(runTurn(request, deps.runnerDeps));
      writeTurnExit(res, exit);
      return;
    }

    let request: SpawnWorkerRequest;
    try {
      request = decodeSpawnRequest(parsed);
    } catch (cause) {
      writeError(res, {
        _tag: "SpawnRequestInvalid",
        reason: cause instanceof Error ? cause.message : String(cause),
      });
      return;
    }
    const exit = yield* Effect.exit(deps.broker.requestWorkerSpawn(request));
    writeSpawnExit(res, exit);
  });
}

function writeTurnExit(
  res: ServerResponse,
  exit: Effect.Effect.Success<ReturnType<typeof Effect.exit<TurnResponse, OrchestratorError, never>>>,
): void {
  if (exit._tag === "Success") {
    const value = exit.value;
    if (value._tag === "Replied") {
      sendJson(res, 200, {
        tag: value._tag,
        newSessionId: value.newSessionId,
        durationMs: value.durationMs,
      });
      return;
    }
    sendJson(res, 200, { tag: value._tag, priorSessionId: value.priorSessionId });
    return;
  }
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "Some") {
    writeError(res, failure.value);
    return;
  }
  sendJson(res, 500, { error: "InternalError" });
}

function writeSpawnExit(
  res: ServerResponse,
  exit: Effect.Effect.Success<
    ReturnType<typeof Effect.exit<SpawnWorkerResponse, OrchestratorError, never>>
  >,
): void {
  if (exit._tag === "Success") {
    const value = exit.value;
    sendJson(res, 200, {
      tag: value._tag,
      agentId: value.agentId,
      worktreePath: value.worktreePath,
    });
    return;
  }
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "Some") {
    writeError(res, failure.value);
    return;
  }
  sendJson(res, 500, { error: "InternalError" });
}

function writeError(res: ServerResponse, error: OrchestratorError): void {
  const rendered = renderErrorResponse(error);
  sendJson(res, rendered.status, rendered.body);
}

function checkAuth(
  req: IncomingMessage,
  secret: SharedSecret,
): { readonly _tag: "Ok" } | { readonly _tag: "Err"; readonly error: OrchestratorError } {
  const header = req.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith(AUTH_HEADER_PREFIX)) {
    return {
      _tag: "Err",
      error: { _tag: "OrchestratorAuthFailed", reason: "missing-header" },
    };
  }
  const presented = header.slice(AUTH_HEADER_PREFIX.length);
  if (presented !== secret) {
    return {
      _tag: "Err",
      error: { _tag: "OrchestratorAuthFailed", reason: "secret-mismatch" },
    };
  }
  return { _tag: "Ok" };
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: Readonly<Record<string, unknown>>,
): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Effect.Effect<string, Error, never> {
  return Effect.async<string, Error, never>((resume) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resume(Effect.succeed(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", (err: Error) => resume(Effect.fail(err)));
  });
}

// Reference imports kept silenced where TypeScript flags them as unused
// in conditional code paths.
const _typeRefs: { readonly r: RepoFullName; readonly p: ProjectSlug } | null = null;
void _typeRefs;
