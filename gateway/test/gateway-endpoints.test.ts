import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { clearRegistry, getAllBridges } from "../src/registry.js";

/**
 * Integration tests for the gateway HTTP endpoints.
 *
 * Spins up a minimal gateway server that mirrors the real routing logic
 * but runs on a random port with a known GATEWAY_SECRET.
 */

const TEST_SECRET = "test-gateway-secret";

// We replicate the gateway's routing inline to avoid starting the real
// server (which has process-level side effects like liveness timers).
// This mirrors the pattern from test/bridge-endpoints.test.ts.

import {
  registerBridge,
  deregisterBridge,
  getBridge,
} from "../src/registry.js";

function errorResponse(status: number, type: string, message: string): Response {
  return Response.json({ error: { type, message, status } }, { status });
}

function verifyAuth(req: Request): boolean {
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${TEST_SECRET}`;
}

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let mockBridge: ReturnType<typeof Bun.serve>;
let mockBridgeUrl: string;

beforeAll(() => {
  // Start a mock bridge that echoes back a success response
  mockBridge = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") {
        return new Response("ok", { status: 200 });
      }
      if (url.pathname === "/api/webhooks/github" && req.method === "POST") {
        const body = await req.text();
        return Response.json({ forwarded: true, bodyLength: body.length });
      }
      return new Response("not found", { status: 404 });
    },
  });
  mockBridgeUrl = `http://localhost:${mockBridge.port}`;

  // Start the gateway test server
  server = Bun.serve({
    port: 0,
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
        for (const header of [
          "content-type",
          "x-github-event",
          "x-github-delivery",
          "x-hub-signature-256",
        ]) {
          const value = req.headers.get(header);
          if (value) forwardHeaders.set(header, value);
        }

        try {
          const upstream = await fetch(forwardUrl, {
            method: "POST",
            headers: forwardHeaders,
            body,
            signal: AbortSignal.timeout(5000),
          });
          const upstreamBody = await upstream.text();
          return new Response(upstreamBody, {
            status: upstream.status,
            headers: { "content-type": upstream.headers.get("content-type") || "text/plain" },
          });
        } catch (err: any) {
          return errorResponse(502, "bridge_error", `Bridge unreachable: ${err.message}`);
        }
      }

      // Bridge registration
      if (pathname === "/api/bridges/register" && req.method === "POST") {
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
        return Response.json({ ok: true, entry });
      }

      // Bridge deregistration
      if (pathname === "/api/bridges/register" && req.method === "DELETE") {
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
        return Response.json({ ok: true, removed });
      }

      return errorResponse(404, "not_found", "Resource not found.");
    },
  });

  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop();
  mockBridge.stop();
});

beforeEach(() => {
  clearRegistry();
});

// ── Tests ───────────────────────────────────────────────────────────

describe("gateway endpoints", () => {
  // ── Health check ──────────────────────────────────────────────────

  it("GET /healthz returns 200 with status and bridge counts", async () => {
    const resp = await fetch(`${baseUrl}/healthz`);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe("ok");
    expect(body.bridges.total).toBe(0);
    expect(body.bridges.active).toBe(0);
  });

  it("GET /healthz reflects registered bridges", async () => {
    registerBridge("acme/app", mockBridgeUrl);
    const resp = await fetch(`${baseUrl}/healthz`);
    const body = await resp.json();
    expect(body.bridges.total).toBe(1);
    expect(body.bridges.active).toBe(1);
  });

  // ── Bridge registration ───────────────────────────────────────────

  it("POST /api/bridges/register without auth returns 401", async () => {
    const resp = await fetch(`${baseUrl}/api/bridges/register`, {
      method: "POST",
      body: JSON.stringify({ repo: "acme/app", bridgeUrl: mockBridgeUrl }),
      headers: { "content-type": "application/json" },
    });
    expect(resp.status).toBe(401);
    const body = await resp.json();
    expect(body.error.type).toBe("authentication_error");
  });

  it("POST /api/bridges/register with auth registers bridge", async () => {
    const resp = await fetch(`${baseUrl}/api/bridges/register`, {
      method: "POST",
      body: JSON.stringify({ repo: "acme/app", bridgeUrl: mockBridgeUrl }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TEST_SECRET}`,
      },
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.entry.repo).toBe("acme/app");
  });

  it("POST /api/bridges/register with missing repo returns 400", async () => {
    const resp = await fetch(`${baseUrl}/api/bridges/register`, {
      method: "POST",
      body: JSON.stringify({ bridgeUrl: mockBridgeUrl }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TEST_SECRET}`,
      },
    });
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error.type).toBe("invalid_request");
  });

  it("POST /api/bridges/register with missing bridgeUrl returns 400", async () => {
    const resp = await fetch(`${baseUrl}/api/bridges/register`, {
      method: "POST",
      body: JSON.stringify({ repo: "acme/app" }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TEST_SECRET}`,
      },
    });
    expect(resp.status).toBe(400);
  });

  it("POST /api/bridges/register with invalid JSON returns 400", async () => {
    const resp = await fetch(`${baseUrl}/api/bridges/register`, {
      method: "POST",
      body: "not json{{{",
      headers: {
        "content-type": "text/plain",
        authorization: `Bearer ${TEST_SECRET}`,
      },
    });
    expect(resp.status).toBe(400);
  });

  // ── Bridge deregistration ─────────────────────────────────────────

  it("DELETE /api/bridges/register without auth returns 401", async () => {
    const resp = await fetch(`${baseUrl}/api/bridges/register`, {
      method: "DELETE",
      body: JSON.stringify({ repo: "acme/app" }),
      headers: { "content-type": "application/json" },
    });
    expect(resp.status).toBe(401);
  });

  it("DELETE /api/bridges/register removes a registered bridge", async () => {
    registerBridge("acme/app", mockBridgeUrl);
    const resp = await fetch(`${baseUrl}/api/bridges/register`, {
      method: "DELETE",
      body: JSON.stringify({ repo: "acme/app" }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TEST_SECRET}`,
      },
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.removed).toBe(true);
    expect(getBridge("acme/app")).toBeUndefined();
  });

  it("DELETE /api/bridges/register for unknown repo returns removed=false", async () => {
    const resp = await fetch(`${baseUrl}/api/bridges/register`, {
      method: "DELETE",
      body: JSON.stringify({ repo: "unknown/repo" }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TEST_SECRET}`,
      },
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.removed).toBe(false);
  });

  // ── Webhook forwarding ────────────────────────────────────────────

  it("POST /api/webhooks/github with no registered bridge returns 502", async () => {
    const payload = JSON.stringify({ repository: { full_name: "acme/app" } });
    const resp = await fetch(`${baseUrl}/api/webhooks/github`, {
      method: "POST",
      body: payload,
      headers: { "content-type": "application/json" },
    });
    expect(resp.status).toBe(502);
    const body = await resp.json();
    expect(body.error.type).toBe("no_bridge");
  });

  it("POST /api/webhooks/github with invalid JSON returns 400", async () => {
    const resp = await fetch(`${baseUrl}/api/webhooks/github`, {
      method: "POST",
      body: "not json{{{",
      headers: { "content-type": "text/plain" },
    });
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error.type).toBe("invalid_request");
  });

  it("POST /api/webhooks/github with missing repo in payload returns 400", async () => {
    const resp = await fetch(`${baseUrl}/api/webhooks/github`, {
      method: "POST",
      body: JSON.stringify({ action: "opened" }),
      headers: { "content-type": "application/json" },
    });
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error.type).toBe("invalid_request");
  });

  it("POST /api/webhooks/github forwards to registered bridge", async () => {
    registerBridge("acme/app", mockBridgeUrl);
    const payload = JSON.stringify({ repository: { full_name: "acme/app" }, action: "opened" });
    const resp = await fetch(`${baseUrl}/api/webhooks/github`, {
      method: "POST",
      body: payload,
      headers: {
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-github-delivery": "abc-123",
        "x-hub-signature-256": "sha256=fakesig",
      },
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.forwarded).toBe(true);
    expect(body.bodyLength).toBe(payload.length);
  });

  it("POST /api/webhooks/github to unreachable bridge returns 502", async () => {
    registerBridge("acme/app", "http://localhost:1");
    const payload = JSON.stringify({ repository: { full_name: "acme/app" } });
    const resp = await fetch(`${baseUrl}/api/webhooks/github`, {
      method: "POST",
      body: payload,
      headers: { "content-type": "application/json" },
    });
    expect(resp.status).toBe(502);
    const body = await resp.json();
    expect(body.error.type).toBe("bridge_error");
  });

  // ── 404 ───────────────────────────────────────────────────────────

  it("unknown endpoint returns 404", async () => {
    const resp = await fetch(`${baseUrl}/not/a/real/endpoint`);
    expect(resp.status).toBe(404);
    const body = await resp.json();
    expect(body.error.type).toBe("not_found");
  });
});
