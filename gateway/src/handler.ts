/**
 * Gateway HTTP route handler — pure function with no side effects.
 *
 * Exported separately from index.ts so tests can import it without
 * triggering server startup, liveness timers, or process.exit.
 */

import {
  registerBridge,
  deregisterBridge,
  getBridge,
  getAllBridges,
} from "./registry.js";
import {
  verifyRequest,
  verifyGitHubPAT,
  requireRepoAccess,
  type AuthConfig,
  type AuthResult,
  type AuthError,
  type PatAuthResult,
} from "./auth.js";

// ── Helpers ─────────────────────────────────────────────────────────

function errorResponse(status: number, type: string, message: string, extra?: Record<string, string>): Response {
  return Response.json({ error: { type, message, status, ...extra } }, { status });
}

function authErrorResponse(error: AuthError): Response {
  const status = error.type === "repo_not_authorized" ? 403 : 401;
  return Response.json(
    { error: { type: error.type, message: error.message, fix: error.fix, status } },
    { status },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface PublishRequestBody {
  repo: string;
  issueNumber: number;
  issueUrl?: string;
}

function decodePublishRequest(body: unknown): PublishRequestBody | Response {
  if (!isRecord(body)) {
    return errorResponse(400, "invalid_request", "Request body must be a JSON object.");
  }

  const { repo, issueNumber, issueUrl } = body;
  if (typeof repo !== "string" || repo.length === 0) {
    return errorResponse(400, "invalid_request", "Missing or invalid 'repo' field.");
  }
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return errorResponse(400, "invalid_request", "Missing or invalid 'issueNumber' field.");
  }
  if (issueUrl !== undefined && typeof issueUrl !== "string") {
    return errorResponse(400, "invalid_request", "Invalid 'issueUrl' field.");
  }

  return { repo, issueNumber, issueUrl };
}

const FORWARDED_HEADERS = [
  "content-type",
  "x-github-event",
  "x-github-delivery",
  "x-hub-signature-256",
  "x-github-hook-id",
  "x-github-hook-installation-target-id",
  "x-github-hook-installation-target-type",
] as const;

// ── Config ──────────────────────────────────────────────────────────

export interface GatewayConfig {
  authConfig: AuthConfig;
  forwardTimeoutMs: number;
}

// ── Handler factory ─────────────────────────────────────────────────

export function createFetchHandler(config: GatewayConfig) {
  const { authConfig, forwardTimeoutMs } = config;

  return async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname === "/healthz" && req.method === "GET") {
      const bridges = getAllBridges();
      const active = bridges.filter((b) => b.active).length;
      return Response.json({ status: "ok", bridges: { total: bridges.length, active } });
    }

    if (pathname === "/api/webhooks/github" && req.method === "POST") {
      return handleWebhookForward(req, forwardTimeoutMs);
    }

    if (pathname === "/api/bridges/register" && req.method === "POST") {
      return handleBridgeRegister(req, authConfig);
    }

    if (pathname === "/api/bridges/register" && req.method === "DELETE") {
      return handleBridgeDeregister(req, authConfig);
    }

    if (pathname === "/api/publish" && req.method === "POST") {
      return handlePublish(req, forwardTimeoutMs);
    }

    if (pathname.match(/^\/api\/workflows\/[^/]+(?:\/history)?$/) && req.method === "GET") {
      return handleWorkflowProxy(req, url, forwardTimeoutMs);
    }

    return errorResponse(404, "not_found", "Resource not found.");
  };
}

// ── Auth helper ────────────────────────────────────────────────────

async function authenticateRequest(
  req: Request,
  authConfig: AuthConfig,
): Promise<AuthResult | Response> {
  const outcome = await verifyRequest(req, authConfig);
  if (!outcome.ok) {
    return authErrorResponse(outcome.error);
  }

  return outcome.result;
}

async function authenticateTeammateRequest(
  req: Request,
  repo: string,
): Promise<PatAuthResult | Response> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) {
    return authErrorResponse({
      type: "missing_token",
      message: "No Authorization header provided.",
      fix: "Include `Authorization: Bearer <github-pat>` header.",
    });
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer" || !parts[1]) {
    return authErrorResponse({
      type: "invalid_token_format",
      message: "Authorization header must be `Bearer <token>`.",
      fix: "Check header format.",
    });
  }

  const outcome = await verifyGitHubPAT(parts[1], repo);
  if (!outcome.ok) {
    return authErrorResponse(outcome.error);
  }

  return outcome.result;
}

// ── Request handlers ────────────────────────────────────────────────

async function handleWebhookForward(req: Request, timeoutMs: number): Promise<Response> {
  const body = await req.text();

  let payload: any;
  try {
    payload = JSON.parse(body);
  } catch {
    return errorResponse(400, "invalid_request", "Request body is not valid JSON.");
  }

  const repo: string = payload.repository?.full_name || "";
  if (!repo) {
    return errorResponse(400, "invalid_request", "Webhook payload missing repository.full_name.");
  }

  const bridge = getBridge(repo);
  if (!bridge) {
    return errorResponse(502, "no_bridge", `No active bridge registered for '${repo}'.`);
  }

  const forwardUrl = `${bridge.bridgeUrl}/api/webhooks/github`;
  const forwardHeaders = new Headers();
  for (const header of FORWARDED_HEADERS) {
    const value = req.headers.get(header);
    if (value) forwardHeaders.set(header, value);
  }

  try {
    const upstream = await globalThis.fetch(forwardUrl, {
      method: "POST",
      headers: forwardHeaders,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });

    const upstreamBody = await upstream.text();
    return new Response(upstreamBody, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") || "text/plain" },
    });
  } catch {
    // Don't leak internal bridge URLs in error responses
    return errorResponse(502, "bridge_error", `Bridge for '${repo}' is unavailable.`);
  }
}

async function handleBridgeRegister(req: Request, authConfig: AuthConfig): Promise<Response> {
  const authOrResp = await authenticateRequest(req, authConfig);
  if (authOrResp instanceof Response) return authOrResp;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "invalid_request", "Request body is not valid JSON.");
  }

  const { repo, bridgeUrl } = body;
  if (!repo || typeof repo !== "string") {
    return errorResponse(400, "invalid_request", "Missing or invalid 'repo' field.");
  }
  if (!bridgeUrl || typeof bridgeUrl !== "string") {
    return errorResponse(400, "invalid_request", "Missing or invalid 'bridgeUrl' field.");
  }

  if (!requireRepoAccess(authOrResp, repo)) {
    return authErrorResponse({
      type: "repo_not_authorized",
      message: `Not authorized for repo ${repo}.`,
      fix: "Ensure the GitHub App is installed on this repository.",
    });
  }

  const entry = registerBridge(repo, bridgeUrl);
  return Response.json({ ok: true, repo: entry.repo, registeredAt: entry.registeredAt });
}

async function handleBridgeDeregister(req: Request, authConfig: AuthConfig): Promise<Response> {
  const authOrResp = await authenticateRequest(req, authConfig);
  if (authOrResp instanceof Response) return authOrResp;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "invalid_request", "Request body is not valid JSON.");
  }

  const { repo } = body;
  if (!repo || typeof repo !== "string") {
    return errorResponse(400, "invalid_request", "Missing or invalid 'repo' field.");
  }

  if (!requireRepoAccess(authOrResp, repo)) {
    return authErrorResponse({
      type: "repo_not_authorized",
      message: `Not authorized for repo ${repo}.`,
      fix: "Ensure the GitHub App is installed on this repository.",
    });
  }

  const removed = deregisterBridge(repo);
  return Response.json({ ok: true, removed });
}

async function handlePublish(
  req: Request,
  timeoutMs: number,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "invalid_request", "Request body is not valid JSON.");
  }

  const decodedBody = decodePublishRequest(body);
  if (decodedBody instanceof Response) {
    return decodedBody;
  }
  const { repo, issueNumber, issueUrl } = decodedBody;

  const authOrResp = await authenticateTeammateRequest(req, repo);
  if (authOrResp instanceof Response) return authOrResp;

  const bridge = getBridge(repo);
  if (!bridge) {
    return errorResponse(502, "no_bridge", `No active bridge registered for '${repo}'.`);
  }

  const callbackToken = crypto.randomUUID().replaceAll("-", "");

  try {
    const tokenRegistration = await globalThis.fetch(`${bridge.bridgeUrl}/api/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: callbackToken,
        issueNumber,
        repo,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!tokenRegistration.ok) {
      return errorResponse(502, "bridge_error", `Bridge for '${repo}' rejected callback registration.`);
    }

    const callbackResp = await globalThis.fetch(
      `${bridge.bridgeUrl}/api/callbacks/plannotator/${issueNumber}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: callbackToken,
          repo,
          event: "plan_published",
          author: authOrResp.user,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );

    if (!callbackResp.ok) {
      return errorResponse(502, "bridge_error", `Bridge for '${repo}' rejected publish callback.`);
    }

    return Response.json({
      ok: true,
      issueNumber,
      issueUrl: issueUrl ?? `https://github.com/${repo}/issues/${issueNumber}`,
    });
  } catch {
    return errorResponse(502, "bridge_error", `Bridge for '${repo}' is unavailable.`);
  }
}

async function handleWorkflowProxy(
  req: Request,
  url: URL,
  timeoutMs: number,
): Promise<Response> {
  const repo = url.searchParams.get("repo");
  if (!repo) {
    return errorResponse(400, "invalid_request", "Missing required 'repo' query parameter.");
  }

  const authOrResp = await authenticateTeammateRequest(req, repo);
  if (authOrResp instanceof Response) return authOrResp;

  const bridge = getBridge(repo);
  if (!bridge) {
    return errorResponse(502, "no_bridge", `No active bridge registered for '${repo}'.`);
  }

  const proxyUrl = new URL(`${bridge.bridgeUrl}${url.pathname}`);
  for (const [key, value] of url.searchParams.entries()) {
    if (key !== "repo") {
      proxyUrl.searchParams.append(key, value);
    }
  }

  try {
    const upstream = await globalThis.fetch(proxyUrl, {
      method: req.method,
      signal: AbortSignal.timeout(timeoutMs),
    });

    const upstreamBody = await upstream.text();
    return new Response(upstreamBody, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") || "text/plain" },
    });
  } catch {
    return errorResponse(502, "bridge_error", `Bridge for '${repo}' is unavailable.`);
  }
}
