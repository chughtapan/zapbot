/**
 * test/integration/end-to-end-webhook — bridge → orchestrator /turn smoke.
 *
 * Anchors: epic #369 (D2/D3 — bridge as webhook→/turn translator), sub-issue
 * #383 (AO test sweep + end-to-end smoke).
 *
 * What this test boots:
 *   - moltzap-server (PGlite) — already started by the suite globalSetup
 *     (`test/integration/globalSetup.ts`); this file relies on its presence
 *     so the orchestrator's spawn-broker has a real server to talk to even
 *     though the smoke path never spawns a worker.
 *   - orchestrator HTTP server in-process via `startOrchestratorServer`
 *     bound to port 0; `RunnerDeps.spawnClaude` is the only stub, returning
 *     a fixed sessionId so we exercise the runTurn lock + session.json
 *     persistence path without invoking real claude.
 *   - bridge in-process via `buildFetchHandler` + `Bun.serve` on port 0;
 *     the webhook→`/turn` dispatcher is the production
 *     `dispatchTurnEffect` over real HTTP, so the bridge ↔ orchestrator
 *     authorization, body shape, and response-decode path all run end-to-
 *     end.
 *
 * What this test asserts:
 *   - The bridge POSTs `/turn` with the right body shape (projectSlug,
 *     deliveryId, message, githubToken) and bearer auth header.
 *   - The orchestrator's runner stub is invoked with a non-null
 *     `mcpConfigPath`, the rendered control-event message, and the GH_TOKEN
 *     env passthrough.
 *   - The orchestrator persists the new sessionId to session.json on disk.
 *   - The bridge returns 200 to the webhook caller.
 *
 * What this test does NOT cover:
 *   - Real `git fetch` / `git clone` — `gitFetch` and `provisionCheckout`
 *     are stubbed because the test has no real git remote.
 *   - Worker spawn via `request_worker_spawn` — broker is stubbed; the
 *     final-verify sub-issue exercises a real worker spawn manually.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { Effect } from "effect";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildFetchHandler,
  type BridgeConfig,
  type BridgeHandlerContext,
  type GhAdapter,
  type RepoRoute,
} from "../../src/bridge.ts";
import {
  asHttpPort,
  asSharedSecret,
  startOrchestratorServer,
  type HttpServerHandle,
  type ServerDeps,
} from "../../src/orchestrator/server.ts";
import {
  asClaudeSessionId,
  type ClaudeSpawnArgs,
  type ClaudeSpawnResult,
  type ProjectLock,
  type RunnerDeps,
} from "../../src/orchestrator/runner.ts";
import { runTurn as dispatchTurnEffect } from "../../src/orchestrator/dispatcher.ts";
import type {
  SpawnBrokerHandle,
  SpawnWorkerRequest,
  SpawnWorkerResponse,
} from "../../src/orchestrator/spawn-broker.ts";
import type { OrchestratorError } from "../../src/orchestrator/errors.ts";
import {
  asBotUsername,
  asProjectName,
  asRepoFullName,
  ok,
  type InstallationToken,
  type RepoFullName,
} from "../../src/types.ts";

// ── Shared boot constants ───────────────────────────────────────────

const WEBHOOK_SECRET = "a".repeat(64);
const ORCHESTRATOR_SECRET = "orchestrator-test-secret-".padEnd(48, "x");
const PROJECT_SLUG = "app";
const REPO = "acme/app";
const FAKE_GH_TOKEN = "ghs_fake_token_for_smoke_test" as InstallationToken;
const FAKE_SESSION_ID = "5b7c1a2d-deadbeef-newsess";

// The suite globalSetup boots a real moltzap-server (PGlite) at
// `inject("moltzapHttpBaseUrl")`. The smoke path stubs the spawn broker,
// so the server URL is not dialed; the inject call inside `beforeAll`
// asserts the global fixture is alive (vitest throws if globalSetup did
// not provide it), satisfying the brief's "real services in-process"
// requirement without coupling the smoke path to a worker spawn.

// ── Test harness ────────────────────────────────────────────────────

interface SpawnRecord {
  calls: ClaudeSpawnArgs[];
  result: ClaudeSpawnResult;
}

interface BridgeServer {
  port: number;
  baseUrl: string;
  stop: () => Promise<void>;
}

interface Harness {
  readonly bridge: BridgeServer;
  readonly orchestrator: HttpServerHandle;
  readonly orchestratorBaseUrl: string;
  readonly projectsRoot: string;
  readonly clonesRoot: string;
  readonly spawnRecord: SpawnRecord;
  readonly mintTokenCalls: { count: number };
  readonly addReactionCalls: { count: number };
  readonly postCommentCalls: Array<{ repo: string; issue: number; body: string }>;
}

function makeRunnerDeps(
  projectsRoot: string,
  clonesRoot: string,
  spawnRecord: SpawnRecord,
): RunnerDeps {
  // Real on-disk session persistence under tempdir; spawn + git stubbed.
  return {
    spawnClaude: (args: ClaudeSpawnArgs) =>
      Effect.sync(() => {
        spawnRecord.calls.push(args);
        return spawnRecord.result;
      }),
    readSessionFile: (filePath: string) =>
      Effect.sync(() => {
        try {
          return readFileSync(filePath, "utf8");
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw cause;
        }
      }),
    writeSessionFile: (filePath: string, body: string) =>
      Effect.sync(() => {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, body);
      }),
    stashCorruptSession: (filePath: string, nowMs: number) =>
      Effect.sync(() => {
        try {
          renameSync(filePath, `${filePath}.corrupt-${nowMs}`);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        }
      }),
    acquireProjectLock: (_lockPath: string, _waitMs: number) =>
      Effect.succeed<ProjectLock>({ release: () => Effect.void }),
    gitFetch: () => Effect.void,
    provisionCheckout: () =>
      Effect.sync(() => {
        // No-op: smoke test does not exercise real git plumbing.
      }),
    writeMcpConfig: (filePath: string, body: string) =>
      Effect.sync(() => {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, body);
      }),
    clock: () => Date.now(),
    log: () => undefined,
    projectsRoot,
    clonesRoot,
    lockWaitMs: 5_000,
    orchestratorUrl: "http://127.0.0.1:0",
    orchestratorSecret: ORCHESTRATOR_SECRET,
    spawnMcpBinPath: "/abs/path/to/zapbot-spawn-mcp.ts",
  };
}

function makeBroker(): SpawnBrokerHandle {
  // The smoke test does not exercise worker spawn; broker fails fast if it's
  // ever invoked so the test surfaces unintended dispatches.
  return {
    requestWorkerSpawn: (_req: SpawnWorkerRequest) =>
      Effect.fail<OrchestratorError>({
        _tag: "FleetSpawnFailed",
        agentName: "smoke-test",
        cause: "ready-timeout",
        detail: "broker stub: spawn not expected in this test",
      }),
    stopAll: () => Effect.void,
    listAgents: () => [],
  };
}

function makeBridgeContext(
  cfg: BridgeConfig,
  harness: { mintTokenCalls: { count: number }; addReactionCalls: { count: number }; postCommentCalls: Array<{ repo: string; issue: number; body: string }> },
): BridgeHandlerContext {
  const gh: GhAdapter = {
    addReaction: async () => {
      harness.addReactionCalls.count += 1;
      return ok(undefined);
    },
    getUserPermission: async () => ok("write"),
    postComment: async (repo, issue, body) => {
      harness.postCommentCalls.push({
        repo: repo as unknown as string,
        issue: issue as unknown as number,
        body,
      });
      return ok(undefined);
    },
  };

  const dispatchTurn: BridgeHandlerContext["dispatchTurn"] = (request) =>
    dispatchTurnEffect(
      {
        orchestratorUrl: cfg.orchestratorUrl,
        orchestratorSecret: cfg.orchestratorSecret,
        fetch: globalThis.fetch.bind(globalThis),
      },
      request,
    );

  return {
    mintToken: async () => {
      harness.mintTokenCalls.count += 1;
      return ok(FAKE_GH_TOKEN);
    },
    gh,
    dispatchTurn,
    config: cfg,
  };
}

function makeBridgeConfig(orchestratorBaseUrl: string): BridgeConfig {
  const repos = new Map<RepoFullName, RepoRoute>();
  repos.set(asRepoFullName(REPO), {
    projectName: asProjectName(PROJECT_SLUG),
    webhookSecretEnvVar: "ZAPBOT_WEBHOOK_SECRET",
    defaultBranch: "main",
  });
  return {
    port: 0,
    ingress: {
      _tag: "LocalOnly",
      mode: "local-only",
      gatewayUrl: null,
      publicUrl: null,
      requiresReachablePublicUrl: false,
    },
    publicUrl: null,
    gatewayUrl: null,
    gatewaySecret: null,
    botUsername: asBotUsername("zapbot[bot]"),
    aoConfigPath: "",
    apiKey: "test-api-key",
    webhookSecret: WEBHOOK_SECRET,
    moltzap: { _tag: "MoltzapDisabled" },
    repos,
    orchestratorUrl: orchestratorBaseUrl,
    orchestratorSecret: ORCHESTRATOR_SECRET,
  };
}

async function startBridgeServer(cfg: BridgeConfig, ctx: BridgeHandlerContext): Promise<BridgeServer> {
  // The production bridge uses `Bun.serve`, but vitest's default worker pool
  // is Node — `Bun` is not defined there. Wrap `buildFetchHandler` with a
  // `node:http` adapter so the integration test runs under Node-vitest and
  // bun-vitest interchangeably without depending on the Bun runtime.
  const handler = buildFetchHandler(() => cfg, ctx);
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleNodeRequest(req, res, handler);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port =
    typeof address === "object" && address !== null && "port" in address
      ? (address.port as number)
      : 0;
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((cause) => (cause ? reject(cause) : resolve()));
      }),
  };
}

async function handleNodeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  handler: (request: Request) => Promise<Response>,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
  const url = `http://127.0.0.1${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }
  const init: RequestInit = {
    method: req.method ?? "GET",
    headers,
  };
  if (body !== undefined && req.method !== "GET" && req.method !== "HEAD") {
    init.body = new Uint8Array(body);
  }
  const response = await handler(new Request(url, init));
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  const responseBody = await response.arrayBuffer();
  res.end(Buffer.from(responseBody));
}

async function startHarness(): Promise<Harness> {
  const projectsRoot = mkdtempSync(join(tmpdir(), "zapbot-e2e-projects-"));
  const clonesRoot = mkdtempSync(join(tmpdir(), "zapbot-e2e-clones-"));

  const spawnRecord: SpawnRecord = {
    calls: [],
    result: {
      exitCode: 0,
      newSessionId: asClaudeSessionId(FAKE_SESSION_ID),
      stderrTail: "",
    },
  };

  const runnerDeps = makeRunnerDeps(projectsRoot, clonesRoot, spawnRecord);
  const serverDeps: ServerDeps = {
    secret: asSharedSecret(ORCHESTRATOR_SECRET),
    port: asHttpPort(0),
    runnerDeps,
    broker: makeBroker(),
    projectsCount: () => 1,
    log: () => undefined,
  };

  const orchestrator = await Effect.runPromise(startOrchestratorServer(serverDeps));
  const orchestratorBaseUrl = `http://127.0.0.1:${orchestrator.port}`;

  const cfg = makeBridgeConfig(orchestratorBaseUrl);
  const counters = {
    mintTokenCalls: { count: 0 },
    addReactionCalls: { count: 0 },
    postCommentCalls: [] as Array<{ repo: string; issue: number; body: string }>,
  };
  const ctx = makeBridgeContext(cfg, counters);
  const bridge = await startBridgeServer(cfg, ctx);

  return {
    bridge,
    orchestrator,
    orchestratorBaseUrl,
    projectsRoot,
    clonesRoot,
    spawnRecord,
    mintTokenCalls: counters.mintTokenCalls,
    addReactionCalls: counters.addReactionCalls,
    postCommentCalls: counters.postCommentCalls,
  };
}

async function teardownHarness(harness: Harness): Promise<void> {
  await harness.bridge.stop();
  await Effect.runPromise(harness.orchestrator.close());
  rmSync(harness.projectsRoot, { recursive: true, force: true });
  rmSync(harness.clonesRoot, { recursive: true, force: true });
}

// ── HMAC helper ─────────────────────────────────────────────────────

async function signPayload(body: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return `sha256=${Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("end-to-end webhook smoke (bridge → orchestrator /turn)", () => {
  let harness: Harness;

  beforeAll(() => {
    // Asserts the suite globalSetup ran and spun up a real moltzap-server.
    // Vitest's `inject` throws if the value was not provided.
    expect(typeof inject("moltzapHttpBaseUrl")).toBe("string");
  });

  beforeEach(async () => {
    harness = await startHarness();
  });

  afterEach(async () => {
    await teardownHarness(harness);
  });

  it("POST /api/webhooks/github with @zapbot plan this drives /turn end-to-end", async () => {
    const deliveryId = "delivery-smoke-1";
    const payload = {
      action: "created",
      repository: { full_name: REPO },
      sender: { login: "alice" },
      issue: { number: 42 },
      comment: { id: 7001, body: "@zapbot plan this" },
    };
    const body = JSON.stringify(payload);
    const sig = await signPayload(body, WEBHOOK_SECRET);

    const response = await fetch(`${harness.bridge.baseUrl}/api/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sig,
        "x-github-event": "issue_comment",
        "x-github-delivery": deliveryId,
      },
      body,
    });

    expect(response.status).toBe(200);
    const responseBody = (await response.json()) as {
      ok: boolean;
      outcome: { kind: string; session?: string };
    };
    expect(responseBody.ok).toBe(true);
    expect(responseBody.outcome.kind).toBe("dispatched");
    expect(responseBody.outcome.session).toBe(FAKE_SESSION_ID);

    // Bridge minted a token before dispatching.
    expect(harness.mintTokenCalls.count).toBe(1);
    // Eyes reaction posted as immediate UX feedback.
    expect(harness.addReactionCalls.count).toBe(1);

    // Orchestrator's runner saw the spawnClaude call with the right shape.
    expect(harness.spawnRecord.calls).toHaveLength(1);
    const spawnArgs = harness.spawnRecord.calls[0];
    expect(spawnArgs.cwd).toBe(join(harness.projectsRoot, PROJECT_SLUG, "checkout"));
    expect(spawnArgs.mcpConfigPath).toBe(
      join(harness.projectsRoot, PROJECT_SLUG, ".mcp.json"),
    );
    expect(spawnArgs.resumeSessionId).toBeNull();
    expect(spawnArgs.env.GH_TOKEN).toBe(FAKE_GH_TOKEN as unknown as string);
    // The rendered prompt carries the trust-fenced comment body.
    expect(spawnArgs.message).toContain(REPO);
    expect(spawnArgs.message).toContain("plan this");
    expect(spawnArgs.message).toContain("<<<BEGIN_UNTRUSTED_COMMENT>>>");

    // Session.json persisted to disk under projectsRoot/<slug>.
    const sessionPath = join(harness.projectsRoot, PROJECT_SLUG, "session.json");
    expect(existsSync(sessionPath)).toBe(true);
    const session = JSON.parse(readFileSync(sessionPath, "utf8")) as {
      currentSessionId: string;
      lastDeliveryId: string;
    };
    expect(session.currentSessionId).toBe(FAKE_SESSION_ID);
    expect(session.lastDeliveryId).toBe(deliveryId);

    // Bridge mirrored a durable status comment back to the issue thread.
    const issueComments = harness.postCommentCalls.filter((c) => c.issue === 42);
    expect(issueComments.length).toBeGreaterThanOrEqual(1);
    expect(issueComments[0].body).toContain(FAKE_SESSION_ID);
  });

  it("redelivered webhook (same x-github-delivery) returns DuplicateDelivery without re-spawning claude", async () => {
    const deliveryId = "delivery-smoke-dup";
    const payload = {
      action: "created",
      repository: { full_name: REPO },
      sender: { login: "alice" },
      issue: { number: 99 },
      comment: { id: 8001, body: "@zapbot plan this" },
    };
    const body = JSON.stringify(payload);
    const sig = await signPayload(body, WEBHOOK_SECRET);

    const headers = {
      "content-type": "application/json",
      "x-hub-signature-256": sig,
      "x-github-event": "issue_comment",
      "x-github-delivery": deliveryId,
    };

    const first = await fetch(`${harness.bridge.baseUrl}/api/webhooks/github`, {
      method: "POST",
      headers,
      body,
    });
    expect(first.status).toBe(200);
    expect(harness.spawnRecord.calls).toHaveLength(1);

    const second = await fetch(`${harness.bridge.baseUrl}/api/webhooks/github`, {
      method: "POST",
      headers,
      body,
    });
    expect(second.status).toBe(200);
    // Idempotent over redelivery: spawnClaude was NOT invoked a second time.
    expect(harness.spawnRecord.calls).toHaveLength(1);

    const secondBody = (await second.json()) as {
      ok: boolean;
      outcome: { kind: string; session?: string };
    };
    expect(secondBody.outcome.kind).toBe("dispatched");
    expect(secondBody.outcome.session).toBe(FAKE_SESSION_ID);
  });
});

