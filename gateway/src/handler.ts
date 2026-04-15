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
  requireRole,
  type AuthConfig,
  type GatewayUser,
  type AuthError,
} from "./auth.js";

// ── Helpers ─────────────────────────────────────────────────────────

function errorResponse(status: number, type: string, message: string, extra?: Record<string, string>): Response {
  return Response.json({ error: { type, message, status, ...extra } }, { status });
}

function authErrorResponse(error: AuthError): Response {
  const status = error.type === "insufficient_role" || error.type === "repo_not_authorized" ? 403 : 401;
  return Response.json(
    { error: { type: error.type, message: error.message, fix: error.fix, status } },
    { status },
  );
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

    if (pathname === "/api/auth/me" && req.method === "GET") {
      return handleAuthMe(req, authConfig);
    }

    return errorResponse(404, "not_found", "Resource not found.");
  };
}

// ── Auth helper ────────────────────────────────────────────────────

async function authenticateRequest(
  req: Request,
  authConfig: AuthConfig,
  requiredRole?: "owner" | "member",
): Promise<GatewayUser | Response> {
  const result = await verifyRequest(req, authConfig);
  if (!result.ok) {
    return authErrorResponse(result.error);
  }

  if (requiredRole && !requireRole(result.user, requiredRole)) {
    return authErrorResponse({
      type: "insufficient_role",
      message: `Operation requires ${requiredRole} role, you have ${result.user.role}.`,
      fix: "Contact bot owner for role upgrade.",
    });
  }

  return result.user;
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
  const userOrResp = await authenticateRequest(req, authConfig, "owner");
  if (userOrResp instanceof Response) return userOrResp;

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

  const entry = registerBridge(repo, bridgeUrl);
  return Response.json({ ok: true, repo: entry.repo, registeredAt: entry.registeredAt });
}

async function handleBridgeDeregister(req: Request, authConfig: AuthConfig): Promise<Response> {
  const userOrResp = await authenticateRequest(req, authConfig, "owner");
  if (userOrResp instanceof Response) return userOrResp;

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

  const removed = deregisterBridge(repo);
  return Response.json({ ok: true, removed });
}

async function handleAuthMe(req: Request, authConfig: AuthConfig): Promise<Response> {
  const userOrResp = await authenticateRequest(req, authConfig);
  if (userOrResp instanceof Response) return userOrResp;

  return Response.json({
    sub: userOrResp.sub,
    email: userOrResp.email,
    role: userOrResp.role,
    authorizedRepos: userOrResp.authorizedRepos,
  });
}
