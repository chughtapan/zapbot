/**
 * Zapbot Gateway — lightweight HTTP proxy for GitHub webhooks.
 *
 * Runs on Railway with a static HTTPS URL. Receives GitHub webhooks
 * and forwards them to registered local bridge instances. Bridges
 * register/deregister on startup/shutdown.
 *
 * Endpoints:
 *   POST   /api/webhooks/github       — forward webhook to registered bridge
 *   POST   /api/bridges/register      — register a bridge
 *   DELETE  /api/bridges/register      — deregister a bridge
 *   GET    /healthz                    — health check
 */

import {
  registerBridge,
  deregisterBridge,
  getBridge,
  getAllBridges,
  touchBridge,
  sweepStaleBridges,
} from "./registry.js";

// ── Config ──────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "8080", 10);
const GATEWAY_SECRET = process.env.GATEWAY_SECRET || "";
const LIVENESS_INTERVAL_MS = parseInt(process.env.LIVENESS_INTERVAL_MS || "30000", 10);
const STALE_TIMEOUT_MS = parseInt(process.env.STALE_TIMEOUT_MS || "60000", 10);
const FORWARD_TIMEOUT_MS = parseInt(process.env.FORWARD_TIMEOUT_MS || "30000", 10);

// ── Helpers ─────────────────────────────────────────────────────────

function errorResponse(status: number, type: string, message: string): Response {
  return Response.json({ error: { type, message, status } }, { status });
}

function log(level: string, message: string, kv: Record<string, unknown> = {}): void {
  const timestamp = new Date().toISOString();
  const kvStr = Object.entries(kv)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  const line = `${timestamp} ${level.toUpperCase().padEnd(5)} [gateway] ${message}${kvStr ? ` (${kvStr})` : ""}`;
  const stream = level === "error" ? process.stderr : process.stdout;
  stream.write(line + "\n");
}

/** Verify that a request carries the correct gateway secret as Bearer token. */
function verifyAuth(req: Request): boolean {
  if (!GATEWAY_SECRET) return false;
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${GATEWAY_SECRET}`;
}

// ── Request handlers ────────────────────────────────────────────────

async function handleWebhookForward(req: Request): Promise<Response> {
  const body = await req.text();

  // Parse payload to extract repo for routing
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
    log("warn", `No active bridge for repo ${repo}`);
    return errorResponse(502, "no_bridge", `No active bridge registered for '${repo}'.`);
  }

  // Forward the full request (headers + body) to the bridge
  const forwardUrl = `${bridge.bridgeUrl}/api/webhooks/github`;
  const forwardHeaders = new Headers();

  // Pass through GitHub's headers
  for (const header of [
    "content-type",
    "x-github-event",
    "x-github-delivery",
    "x-hub-signature-256",
    "x-github-hook-id",
    "x-github-hook-installation-target-id",
    "x-github-hook-installation-target-type",
  ]) {
    const value = req.headers.get(header);
    if (value) forwardHeaders.set(header, value);
  }

  try {
    const upstream = await fetch(forwardUrl, {
      method: "POST",
      headers: forwardHeaders,
      body,
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });

    // Return the bridge's response back to GitHub
    const upstreamBody = await upstream.text();
    return new Response(upstreamBody, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") || "text/plain" },
    });
  } catch (err: any) {
    const message = err.name === "TimeoutError"
      ? `Bridge at ${bridge.bridgeUrl} timed out after ${FORWARD_TIMEOUT_MS}ms`
      : `Bridge at ${bridge.bridgeUrl} unreachable: ${err.message}`;
    log("error", message, { repo });
    return errorResponse(502, "bridge_error", message);
  }
}

async function handleBridgeRegister(req: Request): Promise<Response> {
  if (!verifyAuth(req)) {
    return errorResponse(401, "authentication_error", "Invalid or missing gateway secret.");
  }

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
  log("info", `Bridge registered for ${repo}`, { bridgeUrl });
  return Response.json({ ok: true, entry });
}

async function handleBridgeDeregister(req: Request): Promise<Response> {
  if (!verifyAuth(req)) {
    return errorResponse(401, "authentication_error", "Invalid or missing gateway secret.");
  }

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
  if (removed) {
    log("info", `Bridge deregistered for ${repo}`);
  }
  return Response.json({ ok: true, removed });
}

// ── Server ──────────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    // Health check
    if (pathname === "/healthz" && req.method === "GET") {
      const bridges = getAllBridges();
      const active = bridges.filter((b) => b.active).length;
      return Response.json({ status: "ok", bridges: { total: bridges.length, active } });
    }

    // Webhook forwarding
    if (pathname === "/api/webhooks/github" && req.method === "POST") {
      return handleWebhookForward(req);
    }

    // Bridge registration
    if (pathname === "/api/bridges/register" && req.method === "POST") {
      return handleBridgeRegister(req);
    }

    // Bridge deregistration
    if (pathname === "/api/bridges/register" && req.method === "DELETE") {
      return handleBridgeDeregister(req);
    }

    return errorResponse(404, "not_found", "Resource not found.");
  },
});

// ── Bridge liveness sweep ───────────────────────────────────────────

let livenessTimer: ReturnType<typeof setInterval> | null = null;

function startLivenessSweep(): void {
  livenessTimer = setInterval(async () => {
    // Ping all active bridges, then sweep stale ones
    const bridges = getAllBridges().filter((b) => b.active);
    for (const bridge of bridges) {
      try {
        const resp = await fetch(`${bridge.bridgeUrl}/healthz`, {
          signal: AbortSignal.timeout(5000),
        });
        if (resp.ok) {
          touchBridge(bridge.repo);
        }
      } catch {
        // Bridge didn't respond — will be swept if stale
        log("debug", `Liveness ping failed for ${bridge.repo}`, { bridgeUrl: bridge.bridgeUrl });
      }
    }

    const swept = sweepStaleBridges(STALE_TIMEOUT_MS);
    if (swept.length > 0) {
      log("warn", `Swept stale bridges: ${swept.join(", ")}`);
    }
  }, LIVENESS_INTERVAL_MS);
}

startLivenessSweep();

// ── Graceful shutdown ───────────────────────────────────────────────

process.on("SIGTERM", () => {
  log("info", "Received SIGTERM, shutting down");
  if (livenessTimer) clearInterval(livenessTimer);
  server.stop();
  process.exit(0);
});

process.on("SIGINT", () => {
  log("info", "Received SIGINT, shutting down");
  if (livenessTimer) clearInterval(livenessTimer);
  server.stop();
  process.exit(0);
});

log("info", `Gateway listening on port ${PORT}`);

export { server };
