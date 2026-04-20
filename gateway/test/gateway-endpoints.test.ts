import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { clearRegistry, registerBridge, getBridge } from "../src/registry.js";
import { createFetchHandler } from "../src/handler.js";
import { clearTokenCache, type AuthConfig } from "../src/auth.js";

/**
 * Integration tests for the gateway HTTP endpoints.
 *
 * Uses the exported createFetchHandler to test the real routing logic
 * without starting the production server (which has liveness timers
 * and startup validation that would interfere with tests).
 */

const TEST_GATEWAY_SECRET = "test-gateway-secret";
const TEST_GITHUB_TOKEN = "ghs_test_installation_token";
const TEST_PAT_WRITE = "ghp_writer_pat";
const TEST_PAT_READ = "ghp_reader_pat";

const MOCK_REPOS_RESPONSE = {
  repositories: [
    { full_name: "acme/app" },
    { full_name: "acme/lib" },
  ],
};

const authConfig: AuthConfig = {
  gatewaySecret: TEST_GATEWAY_SECRET,
};

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let mockBridge: ReturnType<typeof Bun.serve>;
let mockBridgeUrl: string;
let tokenRegistrations: Array<{ token: string; issueNumber: number; repo: string }>;
let callbackEvents: Array<{ token: string; repo: string; event: string; author?: string }>;
let workflowRequests: string[];

const originalFetch = globalThis.fetch;

/**
 * Wrap globalThis.fetch so that:
 * - Calls to api.github.com return mocked responses
 * - All other calls (localhost test servers) pass through to real fetch
 */
function installFetchMock() {
  const mockFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("api.github.com")) {
      const headers = init?.headers as Record<string, string> | undefined;
      const authHeader =
        (headers && headers["authorization"]) ||
        (input instanceof Request ? input.headers.get("authorization") : undefined);

      if (url.endsWith("/installation/repositories") && authHeader === `Bearer ${TEST_GITHUB_TOKEN}`) {
        return Response.json(MOCK_REPOS_RESPONSE, { status: 200 });
      }
      if (url.endsWith("/user") && authHeader === `Bearer ${TEST_PAT_WRITE}`) {
        return Response.json({ login: "writer" }, { status: 200 });
      }
      if (url.endsWith("/user") && authHeader === `Bearer ${TEST_PAT_READ}`) {
        return Response.json({ login: "reader" }, { status: 200 });
      }
      if (
        url.endsWith("/repos/acme/app/collaborators/writer/permission") &&
        authHeader === `Bearer ${TEST_PAT_WRITE}`
      ) {
        return Response.json({ permission: "write" }, { status: 200 });
      }
      if (
        url.endsWith("/repos/acme/app/collaborators/reader/permission") &&
        authHeader === `Bearer ${TEST_PAT_READ}`
      ) {
        return Response.json({ permission: "read" }, { status: 200 });
      }
      return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
    }
    // Pass through to real fetch for localhost calls
    return originalFetch(input, init);
  });
  globalThis.fetch = mockFn as typeof globalThis.fetch;
}

beforeAll(() => {
  tokenRegistrations = [];
  callbackEvents = [];
  workflowRequests = [];

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
      if (url.pathname === "/api/tokens" && req.method === "POST") {
        const body = await req.json();
        tokenRegistrations.push(body);
        return Response.json({ ok: true });
      }
      if (url.pathname.match(/^\/api\/callbacks\/plannotator\/\d+$/) && req.method === "POST") {
        const body = await req.json();
        callbackEvents.push(body);
        return Response.json({ ok: true });
      }
      if (url.pathname.match(/^\/api\/workflows\/\d+$/) && req.method === "GET") {
        workflowRequests.push(`${url.pathname}${url.search}`);
        return Response.json({ workflowId: url.pathname.split("/").pop(), status: "running" });
      }
      if (url.pathname.match(/^\/api\/workflows\/\d+\/history$/) && req.method === "GET") {
        workflowRequests.push(`${url.pathname}${url.search}`);
        return Response.json({ events: ["queued", "running"] });
      }
      return new Response("not found", { status: 404 });
    },
  });
  mockBridgeUrl = `http://localhost:${mockBridge.port}`;

  // Start the gateway test server using the real handler
  const handler = createFetchHandler({
    authConfig,
    forwardTimeoutMs: 5000,
  });

  server = Bun.serve({ port: 0, fetch: handler });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop();
  mockBridge.stop();
});

beforeEach(() => {
  clearRegistry();
  clearTokenCache();
  tokenRegistrations = [];
  callbackEvents = [];
  workflowRequests = [];
  installFetchMock();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────────

describe("gateway endpoints", () => {
  // ── Health check ──────────────────────────────────────────────────

  it("GET /healthz returns 200 with status and bridge counts", async () => {
    const resp = await originalFetch(`${baseUrl}/healthz`);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe("ok");
    expect(body.bridges.total).toBe(0);
    expect(body.bridges.active).toBe(0);
  });

  it("GET /healthz reflects registered bridges", async () => {
    registerBridge("acme/app", mockBridgeUrl);
    const resp = await originalFetch(`${baseUrl}/healthz`);
    const body = await resp.json();
    expect(body.bridges.total).toBe(1);
    expect(body.bridges.active).toBe(1);
  });

  // ── Bridge registration ───────────────────────────────────────────

  it("POST /api/bridges/register without auth returns 401", async () => {
    const resp = await originalFetch(`${baseUrl}/api/bridges/register`, {
      method: "POST",
      body: JSON.stringify({ repo: "acme/app", bridgeUrl: mockBridgeUrl }),
      headers: { "content-type": "application/json" },
    });
    expect(resp.status).toBe(401);
    const body = await resp.json();
    expect(body.error.type).toBe("missing_token");
  });

  it("POST /api/bridges/register with shared secret registers bridge", async () => {
    const resp = await originalFetch(`${baseUrl}/api/bridges/register`, {
      method: "POST",
      body: JSON.stringify({ repo: "acme/app", bridgeUrl: mockBridgeUrl }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TEST_GATEWAY_SECRET}`,
      },
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.repo).toBe("acme/app");
    expect(body.bridgeUrl).toBeUndefined(); // bridge URLs must not leak
  });

  it("POST /api/bridges/register with GitHub token registers bridge", async () => {
    const resp = await originalFetch(`${baseUrl}/api/bridges/register`, {
      method: "POST",
      body: JSON.stringify({ repo: "acme/app", bridgeUrl: mockBridgeUrl }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TEST_GITHUB_TOKEN}`,
      },
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.repo).toBe("acme/app");
  });

  it("POST /api/bridges/register with GitHub token for unauthorized repo returns 403", async () => {
    const resp = await originalFetch(`${baseUrl}/api/bridges/register`, {
      method: "POST",
      body: JSON.stringify({ repo: "other/repo", bridgeUrl: mockBridgeUrl }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TEST_GITHUB_TOKEN}`,
      },
    });
    expect(resp.status).toBe(403);
    const body = await resp.json();
    expect(body.error.type).toBe("repo_not_authorized");
  });

  it("POST /api/bridges/register with missing repo returns 400", async () => {
    const resp = await originalFetch(`${baseUrl}/api/bridges/register`, {
      method: "POST",
      body: JSON.stringify({ bridgeUrl: mockBridgeUrl }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TEST_GATEWAY_SECRET}`,
      },
    });
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error.type).toBe("invalid_request");
  });

  it("POST /api/bridges/register with missing bridgeUrl returns 400", async () => {
    const resp = await originalFetch(`${baseUrl}/api/bridges/register`, {
      method: "POST",
      body: JSON.stringify({ repo: "acme/app" }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TEST_GATEWAY_SECRET}`,
      },
    });
    expect(resp.status).toBe(400);
  });

  it("POST /api/bridges/register with invalid JSON returns 400", async () => {
    const resp = await originalFetch(`${baseUrl}/api/bridges/register`, {
      method: "POST",
      body: "not json{{{",
      headers: {
        "content-type": "text/plain",
        authorization: `Bearer ${TEST_GATEWAY_SECRET}`,
      },
    });
    expect(resp.status).toBe(400);
  });

  // ── Bridge deregistration ─────────────────────────────────────────

  it("DELETE /api/bridges/register without auth returns 401", async () => {
    const resp = await originalFetch(`${baseUrl}/api/bridges/register`, {
      method: "DELETE",
      body: JSON.stringify({ repo: "acme/app" }),
      headers: { "content-type": "application/json" },
    });
    expect(resp.status).toBe(401);
  });

  it("DELETE /api/bridges/register with shared secret removes a bridge", async () => {
    registerBridge("acme/app", mockBridgeUrl);
    const resp = await originalFetch(`${baseUrl}/api/bridges/register`, {
      method: "DELETE",
      body: JSON.stringify({ repo: "acme/app" }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TEST_GATEWAY_SECRET}`,
      },
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.removed).toBe(true);
    expect(getBridge("acme/app")).toBeUndefined();
  });

  it("DELETE /api/bridges/register with GitHub token succeeds", async () => {
    registerBridge("acme/app", mockBridgeUrl);
    const resp = await originalFetch(`${baseUrl}/api/bridges/register`, {
      method: "DELETE",
      body: JSON.stringify({ repo: "acme/app" }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TEST_GITHUB_TOKEN}`,
      },
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.removed).toBe(true);
  });

  it("DELETE /api/bridges/register with missing repo returns 400", async () => {
    const resp = await originalFetch(`${baseUrl}/api/bridges/register`, {
      method: "DELETE",
      body: JSON.stringify({}),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TEST_GATEWAY_SECRET}`,
      },
    });
    expect(resp.status).toBe(400);
  });

  it("DELETE /api/bridges/register for unknown repo returns removed=false", async () => {
    const resp = await originalFetch(`${baseUrl}/api/bridges/register`, {
      method: "DELETE",
      body: JSON.stringify({ repo: "unknown/repo" }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TEST_GATEWAY_SECRET}`,
      },
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.removed).toBe(false);
  });

  it("DELETE /api/bridges/register with GitHub token for unauthorized repo returns 403", async () => {
    registerBridge("other/repo", mockBridgeUrl);
    const resp = await originalFetch(`${baseUrl}/api/bridges/register`, {
      method: "DELETE",
      body: JSON.stringify({ repo: "other/repo" }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TEST_GITHUB_TOKEN}`,
      },
    });
    expect(resp.status).toBe(403);
    const body = await resp.json();
    expect(body.error.type).toBe("repo_not_authorized");
  });

  // ── Teammate proxy routes ────────────────────────────────────────

  it("POST /api/publish with write-access PAT registers callback token and forwards publish callback", async () => {
    registerBridge("acme/app", mockBridgeUrl);
    const resp = await originalFetch(`${baseUrl}/api/publish`, {
      method: "POST",
      body: JSON.stringify({
        repo: "acme/app",
        issueNumber: 91,
        issueUrl: "https://github.com/acme/app/issues/91",
      }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TEST_PAT_WRITE}`,
      },
    });

    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.issueUrl).toBe("https://github.com/acme/app/issues/91");
    expect(tokenRegistrations).toHaveLength(1);
    expect(tokenRegistrations[0].issueNumber).toBe(91);
    expect(tokenRegistrations[0].repo).toBe("acme/app");
    expect(callbackEvents).toHaveLength(1);
    expect(callbackEvents[0].event).toBe("plan_published");
    expect(callbackEvents[0].repo).toBe("acme/app");
    expect(callbackEvents[0].author).toBe("writer");
    expect(callbackEvents[0].token).toBe(tokenRegistrations[0].token);
  });

  it("POST /api/publish with read-only PAT returns 403", async () => {
    registerBridge("acme/app", mockBridgeUrl);
    const resp = await originalFetch(`${baseUrl}/api/publish`, {
      method: "POST",
      body: JSON.stringify({ repo: "acme/app", issueNumber: 91 }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TEST_PAT_READ}`,
      },
    });

    expect(resp.status).toBe(403);
    const body = await resp.json();
    expect(body.error.type).toBe("repo_not_authorized");
    expect(tokenRegistrations).toHaveLength(0);
    expect(callbackEvents).toHaveLength(0);
  });

  it("POST /api/publish with invalid PAT returns 401", async () => {
    registerBridge("acme/app", mockBridgeUrl);
    const resp = await originalFetch(`${baseUrl}/api/publish`, {
      method: "POST",
      body: JSON.stringify({ repo: "acme/app", issueNumber: 91 }),
      headers: {
        "content-type": "application/json",
        authorization: "Bearer ghp_invalid_pat",
      },
    });

    expect(resp.status).toBe(401);
    const body = await resp.json();
    expect(body.error.type).toBe("invalid_token");
  });

  it("POST /api/publish rejects non-object JSON bodies", async () => {
    registerBridge("acme/app", mockBridgeUrl);
    const resp = await originalFetch(`${baseUrl}/api/publish`, {
      method: "POST",
      body: "null",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TEST_PAT_WRITE}`,
      },
    });

    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error.type).toBe("invalid_request");
    expect(tokenRegistrations).toHaveLength(0);
    expect(callbackEvents).toHaveLength(0);
  });

  it("GET /api/workflows/:id proxies to the bridge for a teammate with write access", async () => {
    registerBridge("acme/app", mockBridgeUrl);
    const resp = await originalFetch(`${baseUrl}/api/workflows/91?repo=acme/app`, {
      headers: { authorization: `Bearer ${TEST_PAT_WRITE}` },
    });

    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.workflowId).toBe("91");
    expect(body.status).toBe("running");
    expect(workflowRequests).toEqual(["/api/workflows/91"]);
  });

  it("GET /api/workflows/:id/history proxies to the bridge", async () => {
    registerBridge("acme/app", mockBridgeUrl);
    const resp = await originalFetch(`${baseUrl}/api/workflows/91/history?repo=acme/app`, {
      headers: { authorization: `Bearer ${TEST_PAT_WRITE}` },
    });

    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.events).toEqual(["queued", "running"]);
    expect(workflowRequests).toEqual(["/api/workflows/91/history"]);
  });

  it("PAT auth cache avoids a second GitHub API round-trip on repeated workflow checks", async () => {
    registerBridge("acme/app", mockBridgeUrl);

    await originalFetch(`${baseUrl}/api/workflows/91?repo=acme/app`, {
      headers: { authorization: `Bearer ${TEST_PAT_WRITE}` },
    });
    await originalFetch(`${baseUrl}/api/workflows/91/history?repo=acme/app`, {
      headers: { authorization: `Bearer ${TEST_PAT_WRITE}` },
    });

    const githubCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([input]) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        return url.includes("api.github.com");
      });
    expect(githubCalls).toHaveLength(2);
  });

  // ── Webhook forwarding ────────────────────────────────────────────

  it("POST /api/webhooks/github with no registered bridge returns 502", async () => {
    const payload = JSON.stringify({ repository: { full_name: "acme/app" } });
    const resp = await originalFetch(`${baseUrl}/api/webhooks/github`, {
      method: "POST",
      body: payload,
      headers: { "content-type": "application/json" },
    });
    expect(resp.status).toBe(502);
    const body = await resp.json();
    expect(body.error.type).toBe("no_bridge");
  });

  it("POST /api/webhooks/github with invalid JSON returns 400", async () => {
    const resp = await originalFetch(`${baseUrl}/api/webhooks/github`, {
      method: "POST",
      body: "not json{{{",
      headers: { "content-type": "text/plain" },
    });
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error.type).toBe("invalid_request");
  });

  it("POST /api/webhooks/github with missing repo in payload returns 400", async () => {
    const resp = await originalFetch(`${baseUrl}/api/webhooks/github`, {
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
    const resp = await originalFetch(`${baseUrl}/api/webhooks/github`, {
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
    const resp = await originalFetch(`${baseUrl}/api/webhooks/github`, {
      method: "POST",
      body: payload,
      headers: { "content-type": "application/json" },
    });
    expect(resp.status).toBe(502);
    const body = await resp.json();
    expect(body.error.type).toBe("bridge_error");
  });

  // ── /api/auth/me removed ──────────────────────────────────────────

  it("GET /api/auth/me returns 404 (endpoint removed)", async () => {
    const resp = await originalFetch(`${baseUrl}/api/auth/me`, {
      headers: { authorization: `Bearer ${TEST_GATEWAY_SECRET}` },
    });
    expect(resp.status).toBe(404);
  });

  // ── Method mismatch ────────────────────────────────────────────────

  it("GET /api/webhooks/github returns 404", async () => {
    const resp = await originalFetch(`${baseUrl}/api/webhooks/github`);
    expect(resp.status).toBe(404);
  });

  // ── 404 ───────────────────────────────────────────────────────────

  it("unknown endpoint returns 404", async () => {
    const resp = await originalFetch(`${baseUrl}/not/a/real/endpoint`);
    expect(resp.status).toBe(404);
    const body = await resp.json();
    expect(body.error.type).toBe("not_found");
  });
});
