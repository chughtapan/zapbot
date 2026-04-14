import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig, resolveWebhookSecret, type RepoMap, type RepoEntry } from "../src/config/loader.js";
import { reloadConfigFromDisk, parseEnvFile } from "../src/config/reload.js";
import { mapWebhookToEvent } from "../src/webhook/mapper.js";
import { makeWorkflowId } from "../src/workflow-id.js";
import { errorResponse } from "../src/http/error-response.js";
import { verifySignature } from "../src/http/verify-signature.js";

// ── YAML Fixtures ─────────────────────────────────────────────────

const SINGLE_REPO_YAML = `
port: 3000
projects:
  zapbot:
    repo: chughtapan/zapbot
    path: /home/user/zapbot
    defaultBranch: main
    sessionPrefix: zap
    agentRulesFile: .agent-rules.md
    scm:
      plugin: github
      webhook:
        path: /api/webhooks/github
        secretEnvVar: ZAPBOT_API_KEY
        signatureHeader: x-hub-signature-256
        eventHeader: x-github-event
`;

const TWO_REPO_YAML = `
port: 3000
projects:
  zapbot:
    repo: chughtapan/zapbot
    path: /home/user/zapbot
    defaultBranch: main
    sessionPrefix: zap
    agentRulesFile: .agent-rules.md
    scm:
      plugin: github
      webhook:
        path: /api/webhooks/github
        secretEnvVar: ZAPBOT_API_KEY
        signatureHeader: x-hub-signature-256
        eventHeader: x-github-event
  frontend:
    repo: chughtapan/frontend-app
    path: /home/user/frontend
    defaultBranch: main
    sessionPrefix: fe
    agentRulesFile: .agent-rules.md
    scm:
      plugin: github
      webhook:
        path: /api/webhooks/github
        secretEnvVar: ZAPBOT_API_KEY_FRONTEND
        signatureHeader: x-hub-signature-256
        eventHeader: x-github-event
`;

const THREE_REPO_YAML = `
port: 3000
projects:
  zapbot:
    repo: acme/zapbot
    path: /home/user/zapbot
    defaultBranch: main
    sessionPrefix: zap
    agentRulesFile: .agent-rules.md
    scm:
      plugin: github
      webhook:
        path: /api/webhooks/github
        secretEnvVar: ZAPBOT_API_KEY
        signatureHeader: x-hub-signature-256
        eventHeader: x-github-event
  frontend:
    repo: acme/frontend-app
    path: /home/user/frontend
    defaultBranch: develop
    sessionPrefix: fe
    agentRulesFile: .agent-rules.md
    scm:
      plugin: github
      webhook:
        path: /api/webhooks/github
        secretEnvVar: ZAPBOT_API_KEY_FRONTEND
        signatureHeader: x-hub-signature-256
        eventHeader: x-github-event
  api:
    repo: acme/api-server
    path: /home/user/api
    defaultBranch: main
    sessionPrefix: api
    agentRulesFile: .agent-rules.md
    scm:
      plugin: github
      webhook:
        path: /api/webhooks/github
        secretEnvVar: ZAPBOT_API_KEY_API
        signatureHeader: x-hub-signature-256
        eventHeader: x-github-event
`;

// ── Helper to build repoMap ───────────────────────────────────────

function buildTestRepoMap(entries: Array<{
  repo: string;
  projectName: string;
  secretEnvVar?: string;
  defaultBranch?: string;
  sessionPrefix?: string;
}>): RepoMap {
  const map = new Map<string, RepoEntry>();
  for (const e of entries) {
    map.set(e.repo, {
      projectName: e.projectName,
      config: {
        repo: e.repo,
        path: "/tmp/" + e.projectName,
        defaultBranch: e.defaultBranch || "main",
        sessionPrefix: e.sessionPrefix || e.projectName.slice(0, 3),
        agentRulesFile: ".agent-rules.md",
        scm: {
          plugin: "github",
          webhook: {
            path: "/api/webhooks/github",
            secretEnvVar: e.secretEnvVar || "ZAPBOT_API_KEY",
            signatureHeader: "x-hub-signature-256",
            eventHeader: "x-github-event",
          },
        },
      },
    });
  }
  return map;
}

// ── Multi-repo config loading ─────────────────────────────────────

describe("multi-repo config loading", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "zapbot-multi-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.ZAPBOT_REPO;
  });

  it("loads 3 repos from YAML", () => {
    const configPath = join(tmpDir, "ao.yaml");
    writeFileSync(configPath, THREE_REPO_YAML);
    const { repoMap } = loadConfig(configPath);
    expect(repoMap.size).toBe(3);
    expect(repoMap.has("acme/zapbot")).toBe(true);
    expect(repoMap.has("acme/frontend-app")).toBe(true);
    expect(repoMap.has("acme/api-server")).toBe(true);
  });

  it("preserves per-project config fields", () => {
    const configPath = join(tmpDir, "ao.yaml");
    writeFileSync(configPath, THREE_REPO_YAML);
    const { repoMap } = loadConfig(configPath);

    const frontend = repoMap.get("acme/frontend-app");
    expect(frontend!.projectName).toBe("frontend");
    expect(frontend!.config.defaultBranch).toBe("develop");
    expect(frontend!.config.sessionPrefix).toBe("fe");
    expect(frontend!.config.scm.webhook.secretEnvVar).toBe("ZAPBOT_API_KEY_FRONTEND");
  });

  it("preserves per-project path", () => {
    const configPath = join(tmpDir, "ao.yaml");
    writeFileSync(configPath, THREE_REPO_YAML);
    const { repoMap } = loadConfig(configPath);
    expect(repoMap.get("acme/api-server")!.config.path).toBe("/home/user/api");
  });

  it("handles YAML with no projects section", () => {
    const configPath = join(tmpDir, "ao.yaml");
    writeFileSync(configPath, "port: 3000\n");
    const { repoMap } = loadConfig(configPath);
    expect(repoMap.size).toBe(0);
  });

  it("handles YAML with empty projects", () => {
    const configPath = join(tmpDir, "ao.yaml");
    writeFileSync(configPath, "port: 3000\nprojects:\n");
    const { repoMap } = loadConfig(configPath);
    expect(repoMap.size).toBe(0);
  });

  it("skips projects without a repo field", () => {
    const yaml = `
port: 3000
projects:
  valid:
    repo: acme/valid
    path: /tmp/valid
    defaultBranch: main
    sessionPrefix: val
    agentRulesFile: .agent-rules.md
    scm:
      plugin: github
      webhook:
        path: /api/webhooks/github
        secretEnvVar: ZAPBOT_API_KEY
        signatureHeader: x-hub-signature-256
        eventHeader: x-github-event
  invalid:
    path: /tmp/invalid
    defaultBranch: main
`;
    const configPath = join(tmpDir, "ao.yaml");
    writeFileSync(configPath, yaml);
    const { repoMap } = loadConfig(configPath);
    expect(repoMap.size).toBe(1);
    expect(repoMap.has("acme/valid")).toBe(true);
  });

  it("throws for malformed YAML", () => {
    const configPath = join(tmpDir, "bad.yaml");
    writeFileSync(configPath, "projects:\n  - [invalid: {yaml:");
    expect(() => loadConfig(configPath)).toThrow();
  });

  it("single-repo env var sets default scm config", () => {
    process.env.ZAPBOT_REPO = "org/my-repo";
    const { repoMap } = loadConfig();
    const entry = repoMap.get("org/my-repo")!;
    expect(entry.config.scm.webhook.secretEnvVar).toBe("ZAPBOT_API_KEY");
    expect(entry.config.scm.webhook.signatureHeader).toBe("x-hub-signature-256");
    expect(entry.config.sessionPrefix).toBe("my-");
  });
});

// ── Per-repo webhook secret resolution ────────────────────────────

describe("per-repo webhook secret resolution (multi-repo)", () => {
  const SHARED = "shared-key-abc";

  afterEach(() => {
    delete process.env.ZAPBOT_API_KEY_FRONTEND;
    delete process.env.ZAPBOT_API_KEY_API;
    delete process.env.CUSTOM_SECRET;
  });

  it("resolves different secrets for different repos", () => {
    process.env.ZAPBOT_API_KEY_FRONTEND = "fe-secret";
    process.env.ZAPBOT_API_KEY_API = "api-secret";

    const map = buildTestRepoMap([
      { repo: "acme/zapbot", projectName: "zapbot", secretEnvVar: "ZAPBOT_API_KEY" },
      { repo: "acme/frontend", projectName: "frontend", secretEnvVar: "ZAPBOT_API_KEY_FRONTEND" },
      { repo: "acme/api", projectName: "api", secretEnvVar: "ZAPBOT_API_KEY_API" },
    ]);

    expect(resolveWebhookSecret("acme/zapbot", map, SHARED)).toBe(SHARED);
    expect(resolveWebhookSecret("acme/frontend", map, SHARED)).toBe("fe-secret");
    expect(resolveWebhookSecret("acme/api", map, SHARED)).toBe("api-secret");
  });

  it("falls back to shared secret when per-repo env var is missing", () => {
    // ZAPBOT_API_KEY_FRONTEND is NOT set
    const map = buildTestRepoMap([
      { repo: "acme/frontend", projectName: "frontend", secretEnvVar: "ZAPBOT_API_KEY_FRONTEND" },
    ]);
    expect(resolveWebhookSecret("acme/frontend", map, SHARED)).toBe(SHARED);
  });

  it("shared secret used for repos not in map", () => {
    const map = buildTestRepoMap([
      { repo: "acme/zapbot", projectName: "zapbot" },
    ]);
    expect(resolveWebhookSecret("unknown/repo", map, SHARED)).toBe(SHARED);
  });

  it("shared secret used when secretEnvVar equals ZAPBOT_API_KEY", () => {
    const map = buildTestRepoMap([
      { repo: "acme/zapbot", projectName: "zapbot", secretEnvVar: "ZAPBOT_API_KEY" },
    ]);
    expect(resolveWebhookSecret("acme/zapbot", map, SHARED)).toBe(SHARED);
  });

  it("works with custom env var names", () => {
    process.env.CUSTOM_SECRET = "custom-val";
    const map = buildTestRepoMap([
      { repo: "acme/custom", projectName: "custom", secretEnvVar: "CUSTOM_SECRET" },
    ]);
    expect(resolveWebhookSecret("acme/custom", map, SHARED)).toBe("custom-val");
  });
});

// ── Multi-repo webhook routing (bridge simulation) ────────────────

describe("multi-repo webhook routing", () => {
  const SECRET = "bridge-test-secret";

  async function signPayload(payload: string, secret: string): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
    return `sha256=${Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  }

  // Simulates the bridge's routing logic
  async function routeWebhook(
    repoMap: RepoMap,
    repoFullName: string,
    sharedSecret: string,
    payloadSecret: string
  ): Promise<{ status: number; errorType?: string }> {
    if (repoMap.size > 0 && repoFullName && !repoMap.has(repoFullName)) {
      return { status: 403, errorType: "configuration_error" };
    }
    const secret = resolveWebhookSecret(repoFullName, repoMap, sharedSecret);
    const payload = JSON.stringify({ repository: { full_name: repoFullName } });
    const sig = await signPayload(payload, payloadSecret);
    const valid = await verifySignature(payload, sig, secret);
    if (!valid) {
      return { status: 401, errorType: "signature_error" };
    }
    return { status: 200 };
  }

  it("accepts webhook from configured repo with shared secret", async () => {
    const map = buildTestRepoMap([
      { repo: "acme/app", projectName: "app" },
    ]);
    const result = await routeWebhook(map, "acme/app", SECRET, SECRET);
    expect(result.status).toBe(200);
  });

  it("rejects webhook from unconfigured repo with 403", async () => {
    const map = buildTestRepoMap([
      { repo: "acme/app", projectName: "app" },
    ]);
    const result = await routeWebhook(map, "evil/repo", SECRET, SECRET);
    expect(result.status).toBe(403);
  });

  it("accepts webhook from any repo when repoMap is empty (open mode)", async () => {
    const map = new Map<string, RepoEntry>();
    const result = await routeWebhook(map, "random/repo", SECRET, SECRET);
    expect(result.status).toBe(200);
  });

  it("accepts webhook with per-repo secret", async () => {
    process.env.ZAPBOT_API_KEY_FE = "fe-secret-123";
    const map = buildTestRepoMap([
      { repo: "acme/frontend", projectName: "frontend", secretEnvVar: "ZAPBOT_API_KEY_FE" },
    ]);
    const result = await routeWebhook(map, "acme/frontend", SECRET, "fe-secret-123");
    expect(result.status).toBe(200);
    delete process.env.ZAPBOT_API_KEY_FE;
  });

  it("rejects webhook with wrong per-repo secret", async () => {
    process.env.ZAPBOT_API_KEY_FE = "fe-secret-123";
    const map = buildTestRepoMap([
      { repo: "acme/frontend", projectName: "frontend", secretEnvVar: "ZAPBOT_API_KEY_FE" },
    ]);
    const result = await routeWebhook(map, "acme/frontend", SECRET, "wrong-secret");
    expect(result.status).toBe(401);
    delete process.env.ZAPBOT_API_KEY_FE;
  });

  it("routes 2 repos with different secrets correctly", async () => {
    process.env.ZAPBOT_API_KEY_FE = "fe-secret";
    process.env.ZAPBOT_API_KEY_API = "api-secret";
    const map = buildTestRepoMap([
      { repo: "acme/frontend", projectName: "frontend", secretEnvVar: "ZAPBOT_API_KEY_FE" },
      { repo: "acme/api", projectName: "api", secretEnvVar: "ZAPBOT_API_KEY_API" },
    ]);

    // Each repo accepts its own secret
    expect((await routeWebhook(map, "acme/frontend", SECRET, "fe-secret")).status).toBe(200);
    expect((await routeWebhook(map, "acme/api", SECRET, "api-secret")).status).toBe(200);

    // Cross-secret fails
    expect((await routeWebhook(map, "acme/frontend", SECRET, "api-secret")).status).toBe(401);
    expect((await routeWebhook(map, "acme/api", SECRET, "fe-secret")).status).toBe(401);

    delete process.env.ZAPBOT_API_KEY_FE;
    delete process.env.ZAPBOT_API_KEY_API;
  });
});

// ── Webhook mapper: repo context ──────────────────────────────────

describe("webhook mapper: multi-repo context", () => {
  it("extracts repo from different repositories", () => {
    const r1 = mapWebhookToEvent("issues", {
      action: "labeled",
      label: { name: "triage" },
      sender: { login: "alice" },
      issue: { number: 1 },
      repository: { full_name: "acme/frontend" },
    });
    expect(r1!.repo).toBe("acme/frontend");

    const r2 = mapWebhookToEvent("issues", {
      action: "labeled",
      label: { name: "triage" },
      sender: { login: "alice" },
      issue: { number: 2 },
      repository: { full_name: "acme/api-server" },
    });
    expect(r2!.repo).toBe("acme/api-server");
  });

  it("handles missing repository field", () => {
    const result = mapWebhookToEvent("issues", {
      action: "labeled",
      label: { name: "triage" },
      sender: { login: "alice" },
      issue: { number: 1 },
    });
    // Should still return an event with empty repo
    expect(result).not.toBeNull();
    expect(result!.repo).toBe("");
  });

  it("handles null repository.full_name", () => {
    const result = mapWebhookToEvent("issues", {
      action: "labeled",
      label: { name: "triage" },
      sender: { login: "alice" },
      issue: { number: 1 },
      repository: {},
    });
    expect(result!.repo).toBe("");
  });
});

// ── Workflow IDs: repo-scoped ─────────────────────────────────────

describe("workflow IDs: multi-repo scoping", () => {
  it("generates different IDs for same issue in different repos", () => {
    const id1 = makeWorkflowId("acme/frontend", 42);
    const id2 = makeWorkflowId("acme/api", 42);
    expect(id1).not.toBe(id2);
  });

  it("generates same ID for same repo+issue", () => {
    const id1 = makeWorkflowId("acme/app", 10);
    const id2 = makeWorkflowId("acme/app", 10);
    expect(id1).toBe(id2);
  });

  it("handles repos with hyphens and underscores", () => {
    const id = makeWorkflowId("my-org/my_repo-name", 99);
    expect(id).toContain("99");
    expect(id.startsWith("wf-")).toBe(true);
  });
});

// ── Config hot-reload: multi-repo scenarios ───────────────────────

describe("config hot-reload: multi-repo", () => {
  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "zapbot-reload-multi-"));
    savedEnv.ZAPBOT_API_KEY = process.env.ZAPBOT_API_KEY;
    savedEnv.ZAPBOT_REPO = process.env.ZAPBOT_REPO;
    savedEnv.ZAPBOT_API_KEY_FRONTEND = process.env.ZAPBOT_API_KEY_FRONTEND;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reload picks up a newly added repo", () => {
    const envFile = join(tmpDir, ".env");
    const yamlFile = join(tmpDir, "agent-orchestrator.yaml");

    // Start with 1 repo
    writeFileSync(envFile, "ZAPBOT_API_KEY=secret123\n");
    writeFileSync(yamlFile, SINGLE_REPO_YAML);

    const result1 = reloadConfigFromDisk(envFile, yamlFile, "old");
    expect(result1).not.toBeNull();
    expect(result1!.config.repoMap.size).toBe(1);

    // Add second repo
    writeFileSync(yamlFile, TWO_REPO_YAML);
    const result2 = reloadConfigFromDisk(envFile, yamlFile, "secret123");
    expect(result2).not.toBeNull();
    expect(result2!.config.repoMap.size).toBe(2);
    expect(result2!.config.repoMap.has("chughtapan/frontend-app")).toBe(true);
  });

  it("reload picks up a rotated per-repo secret", () => {
    const envFile = join(tmpDir, ".env");
    writeFileSync(envFile, "ZAPBOT_API_KEY=main-secret\nZAPBOT_API_KEY_FRONTEND=old-fe-secret\n");

    // First load
    const result1 = reloadConfigFromDisk(envFile, undefined, "main-secret");
    expect(process.env.ZAPBOT_API_KEY_FRONTEND).toBe("old-fe-secret");

    // Rotate the per-repo secret
    writeFileSync(envFile, "ZAPBOT_API_KEY=main-secret\nZAPBOT_API_KEY_FRONTEND=new-fe-secret\n");
    const result2 = reloadConfigFromDisk(envFile, undefined, "main-secret");
    expect(process.env.ZAPBOT_API_KEY_FRONTEND).toBe("new-fe-secret");
  });

  it("reload detects secret rotation", () => {
    const envFile = join(tmpDir, ".env");
    writeFileSync(envFile, "ZAPBOT_API_KEY=new-secret\nZAPBOT_REPO=acme/app\n");

    const result = reloadConfigFromDisk(envFile, undefined, "old-secret");
    expect(result).not.toBeNull();
    expect(result!.secretRotated).toBe(true);
    expect(result!.config.webhookSecret).toBe("new-secret");
  });

  it("reload preserves config when YAML is invalid", () => {
    const envFile = join(tmpDir, ".env");
    const yamlFile = join(tmpDir, "agent-orchestrator.yaml");

    writeFileSync(envFile, "ZAPBOT_API_KEY=secret\n");
    writeFileSync(yamlFile, "this: is: broken: {yaml");

    const result = reloadConfigFromDisk(envFile, yamlFile, "secret");
    expect(result).toBeNull(); // Should keep old config
  });
});

// ── Bridge endpoint simulation: multi-repo ────────────────────────

describe("bridge endpoints: multi-repo with live server", () => {
  const SHARED_SECRET = "shared-test-secret";
  const FE_SECRET = "fe-test-secret";
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;

  // In-memory callback token store (mimics bridge)
  const callbackTokens = new Map<string, { issueNumber: number; repo: string; createdAt: number }>();

  const configuredRepos = new Map<string, string>([
    ["acme/backend", SHARED_SECRET],
    ["acme/frontend", FE_SECRET],
  ]);

  beforeEach(() => {
    callbackTokens.clear();

    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const pathname = url.pathname;

        if (pathname === "/healthz") {
          return new Response("ok", { status: 200 });
        }

        // Webhook endpoint with multi-repo routing
        if (pathname === "/api/webhooks/github" && req.method === "POST") {
          const body = await req.text();
          let payload: any;
          try { payload = JSON.parse(body); } catch {
            return errorResponse(400, "invalid_request", "Invalid JSON");
          }

          const repoFullName = payload.repository?.full_name || "";

          // Reject unconfigured repos
          if (repoFullName && !configuredRepos.has(repoFullName)) {
            return errorResponse(403, "configuration_error", `Repo '${repoFullName}' not configured`);
          }

          // Per-repo secret
          const secret = configuredRepos.get(repoFullName) || SHARED_SECRET;
          const sig = req.headers.get("x-hub-signature-256");
          if (!(await verifySignature(body, sig, secret))) {
            return errorResponse(401, "signature_error", "Bad signature");
          }

          return new Response("ok", { status: 200 });
        }

        // Token registration
        if (pathname === "/api/tokens" && req.method === "POST") {
          const auth = req.headers.get("authorization");
          if (auth !== `Bearer ${SHARED_SECRET}`) {
            return errorResponse(401, "authentication_error", "Bad key");
          }
          const body = await req.json().catch(() => ({}));
          if (!body.token || body.issueNumber == null) {
            return errorResponse(400, "invalid_request", "Missing fields");
          }
          callbackTokens.set(body.token, {
            issueNumber: body.issueNumber,
            repo: body.repo || "",
            createdAt: Date.now(),
          });
          return Response.json({ ok: true });
        }

        // Callback endpoint with token scoping
        if (pathname.match(/^\/api\/callbacks\/plannotator\/(\d+)$/) && req.method === "POST") {
          const issueNumber = parseInt(pathname.split("/").pop()!, 10);
          const body = await req.json().catch(() => ({}));

          if (!body.token) {
            return errorResponse(401, "authentication_error", "Missing token");
          }
          const stored = callbackTokens.get(body.token);
          if (!stored) {
            return errorResponse(401, "authentication_error", "Invalid token");
          }
          if (stored.issueNumber !== issueNumber) {
            return errorResponse(403, "authorization_error", "Token scoped to different issue");
          }

          return Response.json({ ok: true, repo: stored.repo });
        }

        return errorResponse(404, "not_found", "Not found");
      },
    });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterEach(() => {
    server.stop();
  });

  async function signPayload(payload: string, secret: string): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
    return `sha256=${Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  }

  it("accepts backend webhook with shared secret", async () => {
    const payload = JSON.stringify({ repository: { full_name: "acme/backend" } });
    const sig = await signPayload(payload, SHARED_SECRET);
    const resp = await fetch(`${baseUrl}/api/webhooks/github`, {
      method: "POST", body: payload,
      headers: { "content-type": "application/json", "x-hub-signature-256": sig },
    });
    expect(resp.status).toBe(200);
  });

  it("accepts frontend webhook with per-repo secret", async () => {
    const payload = JSON.stringify({ repository: { full_name: "acme/frontend" } });
    const sig = await signPayload(payload, FE_SECRET);
    const resp = await fetch(`${baseUrl}/api/webhooks/github`, {
      method: "POST", body: payload,
      headers: { "content-type": "application/json", "x-hub-signature-256": sig },
    });
    expect(resp.status).toBe(200);
  });

  it("rejects frontend webhook signed with shared secret", async () => {
    const payload = JSON.stringify({ repository: { full_name: "acme/frontend" } });
    const sig = await signPayload(payload, SHARED_SECRET); // wrong secret
    const resp = await fetch(`${baseUrl}/api/webhooks/github`, {
      method: "POST", body: payload,
      headers: { "content-type": "application/json", "x-hub-signature-256": sig },
    });
    expect(resp.status).toBe(401);
  });

  it("rejects unconfigured repo with 403", async () => {
    const payload = JSON.stringify({ repository: { full_name: "evil/hacker" } });
    const resp = await fetch(`${baseUrl}/api/webhooks/github`, {
      method: "POST", body: payload,
      headers: { "content-type": "application/json" },
    });
    expect(resp.status).toBe(403);
  });

  // Token scoping tests
  it("registers token with repo context", async () => {
    const resp = await fetch(`${baseUrl}/api/tokens`, {
      method: "POST",
      body: JSON.stringify({ token: "tok-1", issueNumber: 10, repo: "acme/backend" }),
      headers: { "content-type": "application/json", authorization: `Bearer ${SHARED_SECRET}` },
    });
    expect(resp.status).toBe(200);
    expect(callbackTokens.get("tok-1")!.repo).toBe("acme/backend");
  });

  it("callback succeeds with matching token and issue", async () => {
    // Register token
    await fetch(`${baseUrl}/api/tokens`, {
      method: "POST",
      body: JSON.stringify({ token: "tok-2", issueNumber: 20, repo: "acme/frontend" }),
      headers: { "content-type": "application/json", authorization: `Bearer ${SHARED_SECRET}` },
    });

    // Use token on matching issue
    const resp = await fetch(`${baseUrl}/api/callbacks/plannotator/20`, {
      method: "POST",
      body: JSON.stringify({ token: "tok-2", event: "plan_published" }),
      headers: { "content-type": "application/json" },
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.repo).toBe("acme/frontend");
  });

  it("callback rejects token scoped to different issue (cross-issue attack)", async () => {
    await fetch(`${baseUrl}/api/tokens`, {
      method: "POST",
      body: JSON.stringify({ token: "tok-3", issueNumber: 30, repo: "acme/backend" }),
      headers: { "content-type": "application/json", authorization: `Bearer ${SHARED_SECRET}` },
    });

    // Try to use token on issue 99 (not 30)
    const resp = await fetch(`${baseUrl}/api/callbacks/plannotator/99`, {
      method: "POST",
      body: JSON.stringify({ token: "tok-3" }),
      headers: { "content-type": "application/json" },
    });
    expect(resp.status).toBe(403);
  });

  it("callback rejects unknown token", async () => {
    const resp = await fetch(`${baseUrl}/api/callbacks/plannotator/1`, {
      method: "POST",
      body: JSON.stringify({ token: "nonexistent-token" }),
      headers: { "content-type": "application/json" },
    });
    expect(resp.status).toBe(401);
  });
});

// ── start.sh multi-repo script validation ─────────────────────────

describe("start.sh: multi-repo script structure", () => {
  const startSh = readFileSync(join(__dirname, "../start.sh"), "utf-8");

  it("extracts repos from agent-orchestrator.yaml via grep", () => {
    expect(startSh).toContain("grep '^\\s\\+repo:' \"$PROJECT_DIR/agent-orchestrator.yaml\"");
  });

  it("builds ZAPBOT_REPOS array", () => {
    expect(startSh).toContain("ZAPBOT_REPOS=()");
    expect(startSh).toContain('ZAPBOT_REPOS+=("$repo")');
  });

  it("registers webhooks for ALL repos in a loop", () => {
    expect(startSh).toContain('for repo in "${ZAPBOT_REPOS[@]}"');
    expect(startSh).toContain("Configuring webhook for");
  });

  it("resolves per-repo secretEnvVar from YAML via awk", () => {
    expect(startSh).toContain("secretEnvVar:");
    expect(startSh).toContain('SECRET_ENV_VAR=$(awk');
  });

  it("uses indirect expansion for per-repo secrets", () => {
    // bash indirect expansion: ${!SECRET_ENV_VAR:-}
    expect(startSh).toContain('RESOLVED="${!SECRET_ENV_VAR:-}"');
  });

  it("deactivates all webhooks on cleanup", () => {
    expect(startSh).toContain('for entry in "${WEBHOOK_IDS[@]}"');
    expect(startSh).toContain('"active":false');
  });

  it("handles backward compat ZAPBOT_REPO env var", () => {
    expect(startSh).toContain('ZAPBOT_REPO:-');
    expect(startSh).toContain('found=false');
  });

  it("errors when no repos found", () => {
    expect(startSh).toContain("No repos found in agent-orchestrator.yaml");
  });
});

// ── team-init --add-repo script validation ────────────────────────

describe("team-init --add-repo script structure", () => {
  const teamInit = readFileSync(join(__dirname, "../bin/zapbot-team-init"), "utf-8");

  it("supports --add-repo flag", () => {
    expect(teamInit).toContain("--add-repo");
    expect(teamInit).toContain("ADD_REPO_MODE=true");
  });

  it("prevents duplicate repos", () => {
    expect(teamInit).toContain('grep -q "repo: ${ZAPBOT_REPO}" "$CONFIG_FILE"');
    expect(teamInit).toContain("already configured");
  });

  it("inserts project block before reactions section", () => {
    expect(teamInit).toContain('grep -n "^reactions:" "$CONFIG_FILE"');
    expect(teamInit).toContain("REACTIONS_LINE");
  });

  it("uses atomic file write with mktemp", () => {
    expect(teamInit).toContain('mktemp "${CONFIG_FILE}');
    expect(teamInit).toContain('mv "$TMPFILE" "$CONFIG_FILE"');
  });

  it("uses trap for cleanup on crash", () => {
    expect(teamInit).toContain('trap "rm -f');
  });

  it("supports --session-prefix flag", () => {
    expect(teamInit).toContain("--session-prefix");
    expect(teamInit).toContain("SESSION_PREFIX=");
  });

  it("creates labels on the new repo", () => {
    // The add-repo path creates labels
    expect(teamInit).toContain("gh label create");
  });

  it("copies agent rules to new repo path", () => {
    expect(teamInit).toContain('cp "$RULES_TEMPLATE" "$REPO_PATH/.agent-rules.md"');
  });
});

// ── AO spawning: script and config ────────────────────────────────

describe("AO spawning: project name from config", () => {
  it("repoMap provides projectName for spawn context", () => {
    const map = buildTestRepoMap([
      { repo: "acme/frontend", projectName: "frontend", sessionPrefix: "fe" },
      { repo: "acme/api", projectName: "api-server", sessionPrefix: "api" },
    ]);

    expect(map.get("acme/frontend")!.projectName).toBe("frontend");
    expect(map.get("acme/api")!.projectName).toBe("api-server");
  });

  it("projectName is undefined for repos not in map", () => {
    const map = buildTestRepoMap([
      { repo: "acme/app", projectName: "app" },
    ]);
    expect(map.get("unknown/repo")).toBeUndefined();
  });
});

describe("AO spawning: spawner script structure", () => {
  const spawner = readFileSync(join(__dirname, "../src/agents/spawner.ts"), "utf-8");

  it("builds ao spawn command with --project flag", () => {
    expect(spawner).toContain('spawnArgs.push("--project", ctx.projectName)');
  });

  it("conditionally adds --project only when projectName exists", () => {
    expect(spawner).toContain("if (ctx.projectName)");
  });

  it("passes ZAPBOT_AGENT_ID and ZAPBOT_AGENT_ROLE as env vars", () => {
    expect(spawner).toContain("ZAPBOT_AGENT_ID: agentId");
    expect(spawner).toContain("ZAPBOT_AGENT_ROLE: ctx.role");
  });

  it("retries failed spawns with delay", () => {
    expect(spawner).toContain("retry_count < session.max_retries");
    expect(spawner).toContain("setTimeout");
    expect(spawner).toContain("5000");
  });

  it("cleans stale worktrees before spawning", () => {
    expect(spawner).toContain("cleanStaleWorktree");
    expect(spawner).toContain("worktree");
  });

  it("re-delivers prompt after 15s delay", () => {
    expect(spawner).toContain("15000");
    expect(spawner).toContain("ao send");
  });

  it("copies role-specific agent rules before spawn", () => {
    expect(spawner).toContain("agent-rules-${ctx.role}.md");
    expect(spawner).toContain("copyFileSync");
  });

  it("cancels pending retry timers on shutdown", () => {
    expect(spawner).toContain("cancelPendingRetries");
    expect(spawner).toContain("pendingTimers.clear()");
  });
});

// ── Template: agent-orchestrator.yaml ─────────────────────────────

describe("agent-orchestrator.yaml template", () => {
  const template = readFileSync(join(__dirname, "../templates/agent-orchestrator.yaml.tmpl"), "utf-8");

  it("has placeholder variables for repo info", () => {
    expect(template).toContain("{{REPO}}");
    expect(template).toContain("{{REPO_PATH}}");
    expect(template).toContain("{{REPO_NAME}}");
  });

  it("has a projects section", () => {
    expect(template).toContain("projects:");
  });

  it("has a reactions section for AO", () => {
    expect(template).toContain("reactions:");
    expect(template).toContain("ci-failed:");
    expect(template).toContain("changes-requested:");
    expect(template).toContain("approved-and-green:");
  });

  it("uses ZAPBOT_API_KEY as default secretEnvVar", () => {
    expect(template).toContain("secretEnvVar: ZAPBOT_API_KEY");
  });

  it("substitution produces valid YAML", () => {
    const resolved = template
      .replace(/\{\{REPO\}\}/g, "acme/my-app")
      .replace(/\{\{REPO_PATH\}\}/g, "/home/user/my-app")
      .replace(/\{\{REPO_NAME\}\}/g, "my-app");

    expect(resolved).not.toContain("{{");
    expect(resolved).toContain("repo: acme/my-app");
    expect(resolved).toContain("path: /home/user/my-app");
  });
});
