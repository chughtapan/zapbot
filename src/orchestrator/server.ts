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

import { Effect } from "effect";
import type { OrchestratorError } from "./errors.ts";
import type {
  RunnerDeps,
  TurnRequest,
  TurnResponse,
} from "./runner.ts";
import type {
  SpawnBrokerHandle,
  SpawnWorkerRequest,
  SpawnWorkerResponse,
} from "./spawn-broker.ts";

// ── Branded identifiers ─────────────────────────────────────────────

export type SharedSecret = string & { readonly __brand: "SharedSecret" };
export type HttpPort = number & { readonly __brand: "HttpPort" };

// ── Public shapes ───────────────────────────────────────────────────

/**
 * Listening HTTP server handle. Returned by `startOrchestratorServer`.
 * `close` is idempotent; it stops accepting new connections, waits up
 * to 5 s for in-flight requests to drain, then force-closes.
 */
export interface HttpServerHandle {
  readonly port: HttpPort;
  readonly close: () => Effect.Effect<void, never, never>;
}

/**
 * Auth-header constant. Both `POST /turn` (called by the bridge) and
 * `POST /spawn` (called by the MCP-tool proxy) authenticate with the
 * same shared secret carried as `Authorization: Bearer <secret>`. The
 * secret is `~/.zapbot/config.json`'s `orchestratorSecret` (added in
 * sub-issue #9; until then sub-issue #3 mints one at boot and writes
 * it back to the config file).
 */
export const AUTH_HEADER_PREFIX = "Bearer ";

// ── Endpoint contracts ──────────────────────────────────────────────

/**
 * `POST /turn` — bridge → orchestrator.
 *
 * Request body (JSON, schema-decoded by the server before dispatch):
 *   {
 *     "projectSlug":  "<branded ProjectSlug>",
 *     "deliveryId":   "<branded DeliveryId>",
 *     "message":      "<rendered user-facing string>",
 *     "githubToken":  "<branded GithubInstallationToken>"
 *   }
 *
 * Response body (JSON):
 *   200  { "tag": "Replied",            "newSessionId": "...", "durationMs": N }
 *   200  { "tag": "DuplicateDelivery",  "priorSessionId": "..." }
 *   401  { "error": "OrchestratorAuthFailed", "reason": "..." }
 *   422  { "error": "TurnRequestInvalid",     "reason": "..." }
 *   429  { "error": "LockTimeout",            "waitedMs": N }
 *   503  { "error": "LeadSessionCorrupted",   "sessionPath": "...", "reason": "..." }
 *   503  { "error": "LeadProcessFailed",      "exitCode": N, "stderrTail": "..." }
 *
 * The bridge maps 5xx + connection failures to its own LauncherError
 * tag `OrchestratorUnreachable`; 401 to `OrchestratorAuthFailed`. All
 * other tags surface to the operator via orchestrator stdout/stderr;
 * the bridge does not attempt automatic retry — GitHub redelivers
 * webhooks in 30-60 s on its own (epic #369 § "Crash semantics").
 */
export interface TurnEndpointContract {
  readonly request: TurnRequest;
  readonly response: TurnResponse;
}

/**
 * `POST /spawn` — MCP-tool proxy (bin/zapbot-spawn-mcp.ts) →
 * orchestrator. Request and response shapes are the broker's
 * SpawnWorkerRequest / SpawnWorkerResponse, JSON-encoded. Auth
 * uses the same shared secret as `/turn`.
 */
export interface SpawnEndpointContract {
  readonly request: SpawnWorkerRequest;
  readonly response: SpawnWorkerResponse;
}

/**
 * `GET /healthz` — start.sh readiness probe.
 *
 * Response 200 `{"ok":true,"port":N,"projects":N}` once the server
 * is accepting; 503 `{"ok":false}` while shutting down.
 */
export interface HealthzResponse {
  readonly ok: boolean;
  readonly port: HttpPort;
  readonly projects: number;
}

// ── DI seam ─────────────────────────────────────────────────────────

/**
 * Server-level dependency seam. Aggregates the runner's deps, the
 * broker handle, and the bound shared secret. Constructed once by the
 * orchestrator entrypoint after config load.
 */
export interface ServerDeps {
  readonly secret: SharedSecret;
  readonly port: HttpPort;
  readonly runnerDeps: RunnerDeps;
  readonly broker: SpawnBrokerHandle;
  readonly log: (
    level: "info" | "warn" | "error",
    msg: string,
    extra?: Record<string, unknown>,
  ) => void;
}

// ── Public surface ──────────────────────────────────────────────────

/**
 * Start the HTTP listener. Returns a handle whose `close` is bound to
 * the orchestrator entrypoint's SIGINT/SIGTERM path. Fails before
 * binding if the port is already held; otherwise the server runs
 * forever and the Effect resolves with the handle as soon as `listen`
 * succeeds.
 */
export function startOrchestratorServer(
  deps: ServerDeps,
): Effect.Effect<HttpServerHandle, OrchestratorError, never> {
  void deps;
  throw new Error("not implemented: startOrchestratorServer");
}

/**
 * Render an `OrchestratorError` to a `{ status, body }` HTTP response.
 * Pure function; no I/O. Used by the dispatch layer inside
 * `startOrchestratorServer`. Lifted to its own export so the
 * MCP-tool proxy bin can use the same mapping when surfacing
 * orchestrator-side failures back through the MCP transport.
 */
export function renderErrorResponse(error: OrchestratorError): {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
} {
  void error;
  throw new Error("not implemented: renderErrorResponse");
}
