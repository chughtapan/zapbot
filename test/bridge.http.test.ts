import { describe, it, expect } from "vitest";
import {
  buildFetchHandler,
  type BridgeConfig,
  type BridgeHandlerContext,
  type GhAdapter,
  type RepoRoute,
} from "../src/bridge.ts";
import {
  asAoSessionName,
  asBotUsername,
  asProjectName,
  asRepoFullName,
  ok,
} from "../src/types.ts";
import { asMoltzapSenderId } from "../src/moltzap/types.ts";
import type { AoControlHost } from "../src/orchestrator/runtime.ts";
import type { RepoFullName } from "../src/types.ts";

// Routes covered here are the HTTP-layer routing of the bridge fetch
// handler — method + path + pre-auth responses. `handleClassifiedWebhook`
// is covered separately in test/bridge.test.ts.

const WEBHOOK_SECRET = "a".repeat(64);
const API_KEY = "b".repeat(64);

async function signPayload(body: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return `sha256=${Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

function makeConfig(
  overrides: { repos?: Map<RepoFullName, RepoRoute>; apiKey?: string; webhookSecret?: string } = {}
): BridgeConfig {
  const defaultRepos = new Map<RepoFullName, RepoRoute>();
  defaultRepos.set(asRepoFullName("acme/app"), {
    projectName: asProjectName("app"),
    webhookSecretEnvVar: "ZAPBOT_WEBHOOK_SECRET",
    defaultBranch: "main",
  });
  return {
    port: 0,
    publicUrl: "http://localhost:0",
    gatewayUrl: "",
    gatewaySecret: null,
    botUsername: asBotUsername("zapbot[bot]"),
    aoConfigPath: "",
    apiKey: overrides.apiKey ?? API_KEY,
    webhookSecret: overrides.webhookSecret ?? WEBHOOK_SECRET,
    moltzap: { _tag: "MoltzapDisabled" },
    repos: overrides.repos ?? defaultRepos,
  };
}

function fakeGh(): GhAdapter {
  return {
    addReaction: async () => ok(undefined),
    getUserPermission: async () => ok("write"),
    postComment: async () => ok(undefined),
  };
}

function fakeAo(): AoControlHost {
  return {
    ensureStarted: async () => ok(undefined),
    resolveReady: async () =>
      ok({
        session: asAoSessionName("app-orchestrator"),
        senderId: asMoltzapSenderId("orch-1"),
        mode: "reused",
      }),
    sendPrompt: async () => ok(undefined),
  };
}

function makeHandler(cfg: BridgeConfig = makeConfig()): (req: Request) => Promise<Response> {
  const ctx: BridgeHandlerContext = {
    mintToken: async () => null,
    gh: fakeGh(),
    aoControlHost: fakeAo(),
    config: cfg,
  };
  return buildFetchHandler(() => cfg, ctx);
}

function get(handler: (r: Request) => Promise<Response>, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return handler(new Request(`http://localhost${path}`, { method: "GET", headers }));
}

function post(
  handler: (r: Request) => Promise<Response>,
  path: string,
  body: string,
  headers: Record<string, string> = {}
): Promise<Response> {
  return handler(new Request(`http://localhost${path}`, { method: "POST", body, headers }));
}

describe("bridge fetch handler — /healthz + catch-all", () => {
  it("GET /healthz returns 200 'ok'", async () => {
    const h = makeHandler();
    const r = await get(h, "/healthz");
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("ok");
  });

  it("GET /unknown returns 404 with typed error body", async () => {
    const h = makeHandler();
    const r = await get(h, "/does-not-exist");
    expect(r.status).toBe(404);
    const body = (await r.json()) as { error: { type: string } };
    expect(body.error.type).toBe("not_found");
  });

  it("GET /api/webhooks/github (wrong method) returns 404", async () => {
    const h = makeHandler();
    const r = await get(h, "/api/webhooks/github");
    expect(r.status).toBe(404);
  });

  it("POST /api/tokens/installation (wrong method) returns 404", async () => {
    const h = makeHandler();
    const r = await post(h, "/api/tokens/installation", "");
    expect(r.status).toBe(404);
  });
});

describe("bridge fetch handler — webhook route", () => {
  const issuePayload = {
    action: "created",
    repository: { full_name: "acme/app" },
    sender: { login: "alice" },
    issue: { number: 1 },
    comment: { id: 1, body: "hi" },
  };

  it("rejects invalid JSON with 400 invalid_request", async () => {
    const h = makeHandler();
    const r = await post(h, "/api/webhooks/github", "not-json-at-all", {
      "x-github-event": "issue_comment",
      "x-github-delivery": "d-1",
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { type: string } }).error.type).toBe("invalid_request");
  });

  it("rejects missing signature with 401 signature_error", async () => {
    const h = makeHandler();
    const body = JSON.stringify(issuePayload);
    const r = await post(h, "/api/webhooks/github", body, {
      "x-github-event": "issue_comment",
      "x-github-delivery": "d-1",
    });
    expect(r.status).toBe(401);
    expect(((await r.json()) as { error: { type: string } }).error.type).toBe("signature_error");
  });

  it("rejects bad signature with 401 signature_error", async () => {
    const h = makeHandler();
    const body = JSON.stringify(issuePayload);
    const r = await post(h, "/api/webhooks/github", body, {
      "x-hub-signature-256": "sha256=deadbeef",
      "x-github-event": "issue_comment",
      "x-github-delivery": "d-1",
    });
    expect(r.status).toBe(401);
    expect(((await r.json()) as { error: { type: string } }).error.type).toBe("signature_error");
  });

  it("collapses unknown-repo into 401 signature_error (pre-auth oracle fix)", async () => {
    // Body claims a repo the bridge is NOT configured for. Must return 401
    // — not 403 "not configured" — so callers can't enumerate.
    const h = makeHandler();
    const body = JSON.stringify({
      ...issuePayload,
      repository: { full_name: "attacker/unknown" },
    });
    const sig = await signPayload(body, WEBHOOK_SECRET);
    const r = await post(h, "/api/webhooks/github", body, {
      "x-hub-signature-256": sig,
      "x-github-event": "issue_comment",
      "x-github-delivery": "d-1",
    });
    expect(r.status).toBe(401);
    const parsed = (await r.json()) as { error: { type: string; message: string } };
    expect(parsed.error.type).toBe("signature_error");
    expect(parsed.error.message.toLowerCase()).not.toContain("unknown");
    expect(parsed.error.message.toLowerCase()).not.toContain("configured");
  });

  it("400 PayloadShapeInvalid on a well-signed malformed issue_comment", async () => {
    const h = makeHandler();
    const body = JSON.stringify({
      action: "created",
      repository: { full_name: "acme/app" },
      sender: { login: "alice" },
      issue: { number: 1 },
      // comment: missing — fails schema decode.
    });
    const sig = await signPayload(body, WEBHOOK_SECRET);
    const r = await post(h, "/api/webhooks/github", body, {
      "x-hub-signature-256": sig,
      "x-github-event": "issue_comment",
      "x-github-delivery": "d-1",
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { type: string } }).error.type).toBe("invalid_request");
  });

  it("well-signed issue_comment on a PR thread returns 200 with dispatched outcome", async () => {
    const h = makeHandler();
    const body = JSON.stringify({
      action: "created",
      repository: { full_name: "acme/app" },
      sender: { login: "alice" },
      issue: {
        number: 1,
        title: "Review the PR thread",
        html_url: "https://github.com/acme/app/issues/1",
        pull_request: { url: "https://api.github.com/repos/acme/app/pulls/1" },
      },
      comment: { id: 1, body: "@zapbot please summarize the current PR state" },
    });
    const sig = await signPayload(body, WEBHOOK_SECRET);
    const r = await post(h, "/api/webhooks/github", body, {
      "x-hub-signature-256": sig,
      "x-github-event": "issue_comment",
      "x-github-delivery": "d-1",
    });
    expect(r.status).toBe(200);
    const parsed = (await r.json()) as { ok: boolean; outcome: { kind: string } };
    expect(parsed.ok).toBe(true);
    expect(parsed.outcome.kind).toBe("dispatched");
  });

  it("well-signed pull_request event returns 200 with ignored outcome", async () => {
    const h = makeHandler();
    const body = JSON.stringify({
      action: "opened",
      repository: { full_name: "acme/app" },
      sender: { login: "alice" },
      pull_request: { number: 1 },
    });
    const sig = await signPayload(body, WEBHOOK_SECRET);
    const r = await post(h, "/api/webhooks/github", body, {
      "x-hub-signature-256": sig,
      "x-github-event": "pull_request",
      "x-github-delivery": "d-1",
    });
    expect(r.status).toBe(200);
    const parsed = (await r.json()) as { ok: boolean; outcome: { kind: string } };
    expect(parsed.ok).toBe(true);
    expect(parsed.outcome.kind).toBe("ignored");
  });

  it("ignores ambient webhook secret env and uses BridgeConfig", async () => {
    const saved = process.env.ZAPBOT_WEBHOOK_SECRET;
    process.env.ZAPBOT_WEBHOOK_SECRET = "wrong-wrong-wrong-wrong-wrong-wrong-wrong-wrong";
    try {
      const h = makeHandler();
      const body = JSON.stringify({
        action: "opened",
        repository: { full_name: "acme/app" },
        sender: { login: "alice" },
        pull_request: { number: 1 },
      });
      const sig = await signPayload(body, WEBHOOK_SECRET);
      const r = await post(h, "/api/webhooks/github", body, {
        "x-hub-signature-256": sig,
        "x-github-event": "pull_request",
        "x-github-delivery": "d-1",
      });
      expect(r.status).toBe(200);
    } finally {
      if (saved !== undefined) process.env.ZAPBOT_WEBHOOK_SECRET = saved;
      else delete process.env.ZAPBOT_WEBHOOK_SECRET;
    }
  });
});

describe("bridge fetch handler — installation token broker", () => {
  it("GET without Authorization returns 401 unauthorized", async () => {
    const h = makeHandler();
    const r = await get(h, "/api/tokens/installation");
    expect(r.status).toBe(401);
    expect((await r.json()).error).toBe("unauthorized");
  });

  it("GET with wrong Bearer returns 401 unauthorized", async () => {
    const h = makeHandler();
    const r = await get(h, "/api/tokens/installation", {
      authorization: `Bearer ${"x".repeat(API_KEY.length)}`,
    });
    expect(r.status).toBe(401);
  });

  it("GET with correct Bearer but no GitHub App returns 409 app_not_configured", async () => {
    const h = makeHandler();
    const r = await get(h, "/api/tokens/installation", {
      authorization: `Bearer ${API_KEY}`,
    });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("app_not_configured");
  });

  it("uses the injected mintToken seam even when GitHub App env is present", async () => {
    const savedAppId = process.env.GITHUB_APP_ID;
    const savedInstallationId = process.env.GITHUB_APP_INSTALLATION_ID;
    const savedPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY;
    process.env.GITHUB_APP_ID = "123456";
    process.env.GITHUB_APP_INSTALLATION_ID = "654321";
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN PRIVATE KEY----- fake";
    const saved = process.env.ZAPBOT_API_KEY;
    delete process.env.ZAPBOT_API_KEY;
    try {
      const minted = {
        token: "ghs_mockinstallationtoken",
        expiresAt: "2026-04-18T03:59:59Z",
      };
      const h = buildFetchHandler(
        () => makeConfig(),
        {
          mintToken: async () => minted,
          gh: fakeGh(),
          aoControlHost: fakeAo(),
          config: makeConfig(),
        }
      );
      const r = await get(h, "/api/tokens/installation", {
        authorization: `Bearer ${API_KEY}`,
      });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({
        token: minted.token,
        expires_at: minted.expiresAt,
      });
    } finally {
      if (savedAppId !== undefined) process.env.GITHUB_APP_ID = savedAppId;
      else delete process.env.GITHUB_APP_ID;
      if (savedInstallationId !== undefined) process.env.GITHUB_APP_INSTALLATION_ID = savedInstallationId;
      else delete process.env.GITHUB_APP_INSTALLATION_ID;
      if (savedPrivateKey !== undefined) process.env.GITHUB_APP_PRIVATE_KEY = savedPrivateKey;
      else delete process.env.GITHUB_APP_PRIVATE_KEY;
      if (saved !== undefined) process.env.ZAPBOT_API_KEY = saved;
      else delete process.env.ZAPBOT_API_KEY;
    }
  });
});
