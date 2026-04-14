import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { errorResponse } from "../src/http/error-response.js";
import { verifySignature } from "../src/http/verify-signature.js";

/**
 * Integration-style tests for the webhook bridge HTTP layer.
 *
 * Rather than starting the full bridge (which has heavy side effects:
 * database init, config loading, heartbeat checker, agent spawning),
 * we spin up a minimal Bun server that replicates the bridge's routing
 * and error handling using the same extracted modules.
 */

const TEST_SECRET = "test-secret-for-bridge-endpoints";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
} as const;

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0, // random available port
    async fetch(req) {
      const url = new URL(req.url);
      const pathname = url.pathname;

      // Health check
      if (pathname === "/healthz") {
        return new Response("ok", { status: 200 });
      }

      // GitHub webhook
      if (pathname === "/api/webhooks/github" && req.method === "POST") {
        const body = await req.text();
        const signature = req.headers.get("x-hub-signature-256");

        let payload: any;
        try {
          payload = JSON.parse(body);
        } catch {
          return errorResponse(400, "invalid_request", "Request body is not valid JSON.");
        }

        const repoFullName: string = payload.repository?.full_name || "";

        // Simulate unconfigured repo check (we configure only "acme/app")
        const configuredRepos = new Set(["acme/app"]);
        if (configuredRepos.size > 0 && repoFullName && !configuredRepos.has(repoFullName)) {
          return errorResponse(403, "configuration_error", `Repo '${repoFullName}' is not configured on this bridge.`);
        }

        if (!(await verifySignature(body, signature, TEST_SECRET))) {
          return errorResponse(401, "signature_error", "Webhook signature verification failed.");
        }

        return new Response("ok", { status: 200 });
      }

      // Workflow state API
      if (pathname.match(/^\/api\/workflows\/(\d+)$/) && req.method === "GET") {
        const auth = req.headers.get("authorization");
        if (auth !== `Bearer ${TEST_SECRET}`) {
          return errorResponse(401, "authentication_error", "Invalid API key.");
        }
        // No real DB — always 404
        const issueNumber = parseInt(pathname.split("/").pop()!, 10);
        return errorResponse(404, "not_found", `No workflow found for issue #${issueNumber}.`);
      }

      // Token registration
      if (pathname === "/api/tokens" && req.method === "POST") {
        const auth = req.headers.get("authorization");
        if (auth !== `Bearer ${TEST_SECRET}`) {
          return errorResponse(401, "authentication_error", "Invalid API key.");
        }
        const body = await req.json().catch(() => ({}));
        const { token, issueNumber } = body;
        if (!token || typeof token !== "string" || issueNumber == null || typeof issueNumber !== "number") {
          return errorResponse(400, "invalid_request", "Missing or invalid token/issueNumber in request body.");
        }
        return Response.json({ ok: true });
      }

      // CORS preflight for plannotator callbacks
      if (pathname.match(/^\/api\/callbacks\/plannotator\/(\d+)$/) && req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      // Plannotator callback
      if (pathname.match(/^\/api\/callbacks\/plannotator\/(\d+)$/) && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        if (!body.token || typeof body.token !== "string") {
          const resp = errorResponse(401, "authentication_error", "Missing callback token.");
          for (const [k, v] of Object.entries(CORS_HEADERS)) resp.headers.set(k, v);
          return resp;
        }
        // No stored tokens in this test server
        const resp = errorResponse(401, "authentication_error", "Invalid or expired callback token.");
        for (const [k, v] of Object.entries(CORS_HEADERS)) resp.headers.set(k, v);
        return resp;
      }

      return errorResponse(404, "not_found", "Resource not found.");
    },
  });

  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop();
});

// ── Helper ──────────────────────────────────────────────────────────

async function signPayload(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return `sha256=${Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("bridge endpoints", () => {
  // GET /healthz
  it("GET /healthz returns 200 ok", async () => {
    const resp = await fetch(`${baseUrl}/healthz`);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("ok");
  });

  // POST /api/webhooks/github with invalid JSON
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

  // POST /api/webhooks/github with bad signature
  it("POST /api/webhooks/github with bad signature returns 401", async () => {
    const payload = JSON.stringify({ repository: { full_name: "acme/app" } });
    const resp = await fetch(`${baseUrl}/api/webhooks/github`, {
      method: "POST",
      body: payload,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=invalid",
      },
    });
    expect(resp.status).toBe(401);
    const body = await resp.json();
    expect(body.error.type).toBe("signature_error");
  });

  // POST /api/webhooks/github from unconfigured repo
  it("POST /api/webhooks/github from unconfigured repo returns 403", async () => {
    const payload = JSON.stringify({ repository: { full_name: "unknown/repo" } });
    const resp = await fetch(`${baseUrl}/api/webhooks/github`, {
      method: "POST",
      body: payload,
      headers: { "content-type": "application/json" },
    });
    expect(resp.status).toBe(403);
    const body = await resp.json();
    expect(body.error.type).toBe("configuration_error");
  });

  // POST /api/webhooks/github with valid signature
  it("POST /api/webhooks/github with valid signature returns 200", async () => {
    const payload = JSON.stringify({ repository: { full_name: "acme/app" } });
    const sig = await signPayload(payload, TEST_SECRET);
    const resp = await fetch(`${baseUrl}/api/webhooks/github`, {
      method: "POST",
      body: payload,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sig,
      },
    });
    expect(resp.status).toBe(200);
  });

  // GET /api/workflows/99 without auth
  it("GET /api/workflows/99 without auth returns 401", async () => {
    const resp = await fetch(`${baseUrl}/api/workflows/99`);
    expect(resp.status).toBe(401);
    const body = await resp.json();
    expect(body.error.type).toBe("authentication_error");
  });

  // GET /api/workflows/99 with auth but no workflow
  it("GET /api/workflows/99 with auth returns 404 when workflow missing", async () => {
    const resp = await fetch(`${baseUrl}/api/workflows/99`, {
      headers: { authorization: `Bearer ${TEST_SECRET}` },
    });
    expect(resp.status).toBe(404);
    const body = await resp.json();
    expect(body.error.type).toBe("not_found");
  });

  // POST /api/tokens without auth
  it("POST /api/tokens without auth returns 401", async () => {
    const resp = await fetch(`${baseUrl}/api/tokens`, {
      method: "POST",
      body: JSON.stringify({ token: "abc", issueNumber: 1 }),
      headers: { "content-type": "application/json" },
    });
    expect(resp.status).toBe(401);
    const body = await resp.json();
    expect(body.error.type).toBe("authentication_error");
  });

  // POST /api/tokens with auth but missing fields
  it("POST /api/tokens with auth but missing fields returns 400", async () => {
    const resp = await fetch(`${baseUrl}/api/tokens`, {
      method: "POST",
      body: JSON.stringify({}),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TEST_SECRET}`,
      },
    });
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error.type).toBe("invalid_request");
  });

  // POST /api/tokens with valid data
  it("POST /api/tokens with valid data returns ok", async () => {
    const resp = await fetch(`${baseUrl}/api/tokens`, {
      method: "POST",
      body: JSON.stringify({ token: "tok-abc", issueNumber: 42, repo: "acme/app" }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TEST_SECRET}`,
      },
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
  });

  // POST /api/callbacks/plannotator/99 without token
  it("POST /api/callbacks/plannotator/99 without token returns 401", async () => {
    const resp = await fetch(`${baseUrl}/api/callbacks/plannotator/99`, {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    expect(resp.status).toBe(401);
    const body = await resp.json();
    expect(body.error.type).toBe("authentication_error");
  });

  // OPTIONS /api/callbacks/plannotator/99 returns CORS headers
  it("OPTIONS /api/callbacks/plannotator/99 returns 204 with CORS headers", async () => {
    const resp = await fetch(`${baseUrl}/api/callbacks/plannotator/99`, {
      method: "OPTIONS",
    });
    expect(resp.status).toBe(204);
    expect(resp.headers.get("access-control-allow-origin")).toBe("*");
    expect(resp.headers.get("access-control-allow-methods")).toContain("POST");
  });

  // GET /nonexistent returns 404
  it("GET /nonexistent returns 404 structured error", async () => {
    const resp = await fetch(`${baseUrl}/nonexistent`);
    expect(resp.status).toBe(404);
    const body = await resp.json();
    expect(body.error.type).toBe("not_found");
    expect(body.error.message).toBe("Resource not found.");
  });
});
