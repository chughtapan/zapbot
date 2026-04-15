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

// ── Helpers ─────────────────────────────────────────────────────────

function errorResponse(status: number, type: string, message: string): Response {
  return Response.json({ error: { type, message, status } }, { status });
}

function verifyAuth(req: Request, secret: string): boolean {
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${secret}`;
}

async function parseAuthenticatedBody(req: Request, secret: string): Promise<any | Response> {
  if (!verifyAuth(req, secret)) {
    return errorResponse(401, "authentication_error", "Invalid or missing gateway secret.");
  }
  try {
    return await req.json();
  } catch {
    return errorResponse(400, "invalid_request", "Request body is not valid JSON.");
  }
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
  gatewaySecret: string;
  forwardTimeoutMs: number;
}

// ── Handler factory ─────────────────────────────────────────────────

export function createFetchHandler(config: GatewayConfig) {
  const { gatewaySecret, forwardTimeoutMs } = config;

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
      return handleBridgeRegister(req, gatewaySecret);
    }

    if (pathname === "/api/bridges/register" && req.method === "DELETE") {
      return handleBridgeDeregister(req, gatewaySecret);
    }

    return errorResponse(404, "not_found", "Resource not found.");
  };
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
  } catch (err: any) {
    const message = err.name === "TimeoutError"
      ? `Bridge at ${bridge.bridgeUrl} timed out after ${timeoutMs}ms`
      : `Bridge at ${bridge.bridgeUrl} unreachable: ${err.message}`;
    return errorResponse(502, "bridge_error", message);
  }
}

async function handleBridgeRegister(req: Request, secret: string): Promise<Response> {
  const body = await parseAuthenticatedBody(req, secret);
  if (body instanceof Response) return body;

  const { repo, bridgeUrl } = body;
  if (!repo || typeof repo !== "string") {
    return errorResponse(400, "invalid_request", "Missing or invalid 'repo' field.");
  }
  if (!bridgeUrl || typeof bridgeUrl !== "string") {
    return errorResponse(400, "invalid_request", "Missing or invalid 'bridgeUrl' field.");
  }

  const entry = registerBridge(repo, bridgeUrl);
  return Response.json({ ok: true, entry });
}

async function handleBridgeDeregister(req: Request, secret: string): Promise<Response> {
  const body = await parseAuthenticatedBody(req, secret);
  if (body instanceof Response) return body;

  const { repo } = body;
  if (!repo || typeof repo !== "string") {
    return errorResponse(400, "invalid_request", "Missing or invalid 'repo' field.");
  }

  const removed = deregisterBridge(repo);
  return Response.json({ ok: true, removed });
}
