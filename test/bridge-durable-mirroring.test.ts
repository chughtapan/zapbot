import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getIssueMock = vi.hoisted(() => vi.fn());

vi.mock("../src/github-state.ts", () => ({
  getIssue: getIssueMock,
}));

import {
  handleClassifiedWebhook,
  type BridgeConfig,
  type BridgeHandlerContext,
  type GhAdapter,
  type RepoRoute,
} from "../src/bridge.ts";
import type { ClassifiedWebhook } from "../src/gateway.ts";
import { asMoltzapSenderId } from "../src/moltzap/types.ts";
import type { AoControlHost } from "../src/orchestrator/runtime.ts";
import {
  asAoSessionName,
  asBotUsername,
  asCommentId,
  asDeliveryId,
  asIssueNumber,
  asProjectName,
  asRepoFullName,
  ok,
} from "../src/types.ts";
import type {
  DispatchError,
  GhCallError,
  InstallationToken,
  IssueNumber,
  RepoFullName,
  Result,
} from "../src/types.ts";

const repo = asRepoFullName("acme/app");
const issue = asIssueNumber(42);
const commentId = asCommentId(7);
const bot = asBotUsername("zapbot[bot]");

interface FakeGhCalls {
  addReaction: Array<{ repo: RepoFullName; commentId: number; reaction: string }>;
  getUserPermission: Array<{ repo: RepoFullName; user: string }>;
  postComment: Array<{ repo: RepoFullName; issue: IssueNumber; body: string }>;
}

function makeGh(): { gh: GhAdapter; calls: FakeGhCalls } {
  const calls: FakeGhCalls = { addReaction: [], getUserPermission: [], postComment: [] };
  const gh: GhAdapter = {
    addReaction: async (nextRepo, nextCommentId, reaction) => {
      calls.addReaction.push({ repo: nextRepo, commentId: nextCommentId, reaction });
      return ok(undefined);
    },
    getUserPermission: async (nextRepo, user) => {
      calls.getUserPermission.push({ repo: nextRepo, user });
      return ok("write");
    },
    postComment: async (nextRepo, nextIssue, body) => {
      calls.postComment.push({ repo: nextRepo, issue: nextIssue, body });
      return ok(undefined);
    },
  };
  return { gh, calls };
}

function makeAoHost(): AoControlHost {
  return {
    ensureStarted: async () => ok(undefined),
    resolveReady: async () => ok({
      session: asAoSessionName("app-orchestrator"),
      senderId: asMoltzapSenderId("orch-1"),
      mode: "reused",
    }),
    sendPrompt: async () => ok(undefined),
  };
}

function makeConfig(): BridgeConfig {
  const repos = new Map<RepoFullName, RepoRoute>();
  repos.set(repo, {
    projectName: asProjectName("app"),
    webhookSecretEnvVar: "ZAPBOT_WEBHOOK_SECRET",
    defaultBranch: "main",
  });
  return {
    port: 3000,
    publicUrl: "http://localhost:3000",
    gatewayUrl: "",
    gatewaySecret: null,
    botUsername: bot,
    aoConfigPath: "",
    apiKey: "test-broker-key",
    webhookSecret: "test-webhook-secret",
    moltzap: { _tag: "MoltzapDisabled" },
    repos,
  };
}

function makeCtx(gh: GhAdapter): BridgeHandlerContext {
  return {
    mintToken: async () => ok("fake-token" as unknown as InstallationToken),
    gh,
    aoControlHost: makeAoHost(),
    config: makeConfig(),
  };
}

function asMention(kind: "status"): ClassifiedWebhook {
  return {
    kind: "mention_command",
    repo,
    issue,
    commentId,
    commentBody: "@zapbot status",
    deliveryId: asDeliveryId("delivery-1"),
    command: { kind },
    triggeredBy: "carol",
  };
}

describe("handleClassifiedWebhook durable mirroring", () => {
  const originalToken = process.env.ZAPBOT_GITHUB_TOKEN;

  beforeEach(() => {
    getIssueMock.mockReset();
    getIssueMock.mockResolvedValue(ok({
      repo,
      number: issue,
      state: "open",
      labels: ["zapbot-plan"],
      assignees: ["zapbot[bot]"],
      body: "",
      author: "carol",
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalToken === undefined) {
      delete process.env.ZAPBOT_GITHUB_TOKEN;
      return;
    }
    process.env.ZAPBOT_GITHUB_TOKEN = originalToken;
  });

  it("does not mirror to a cross-repo linked pull request (skips when repository_url differs)", async () => {
    process.env.ZAPBOT_GITHUB_TOKEN = "test-token";

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/issues/42/events?per_page=100&page=1")) {
        return Response.json([
          {
            event: "cross-referenced",
            created_at: "2026-04-20T10:00:00Z",
            source: {
              type: "pull_request",
              issue: {
                number: 99,
                repository_url: "https://api.github.com/repos/other-org/other-repo",
              },
            },
          },
        ]);
      }
      throw new Error(`unexpected url ${url}`);
    });

    const { gh, calls } = makeGh();
    const out = await handleClassifiedWebhook(asMention("status"), makeCtx(gh));

    expect(out).toEqual({
      _tag: "Ok",
      value: { kind: "replied", command: "status" },
    });
    expect(fetchSpy).toHaveBeenCalled();
    // Cross-repo cross-reference is filtered out: only the original issue post happens, no mirror.
    expect(calls.postComment.map((call) => call.repo as unknown as string)).toEqual(["acme/app"]);
    expect(calls.postComment.map((call) => call.issue as unknown as number)).toEqual([42]);
  });

  it("mirrors when repository_url is present and matches anchor repo", async () => {
    process.env.ZAPBOT_GITHUB_TOKEN = "test-token";

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/issues/42/events?per_page=100&page=1")) {
        return Response.json([
          {
            event: "cross-referenced",
            created_at: "2026-04-20T10:00:00Z",
            source: {
              type: "pull_request",
              issue: {
                number: 50,
                repository_url: "https://api.github.com/repos/acme/app",
              },
            },
          },
        ]);
      }
      throw new Error(`unexpected url ${url}`);
    });

    const { gh, calls } = makeGh();
    await handleClassifiedWebhook(asMention("status"), makeCtx(gh));

    expect(calls.postComment.map((call) => call.issue as unknown as number)).toEqual([42, 50]);
  });

  it("mirrors the status summary to the latest linked pull request", async () => {
    process.env.ZAPBOT_GITHUB_TOKEN = "test-token";

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/issues/42/events?per_page=100&page=1")) {
        return Response.json([
          {
            event: "cross-referenced",
            created_at: "2026-04-20T10:00:00Z",
            source: { type: "pull_request", pull_request: { number: 17 } },
          },
          ...Array.from({ length: 99 }, (_, index) => ({
            event: "labeled",
            created_at: `2026-04-20T10:${String(index % 60).padStart(2, "0")}:00Z`,
            source: null,
          })),
        ]);
      }
      if (url.includes("/issues/42/events?per_page=100&page=2")) {
        return Response.json([
          {
            event: "cross-referenced",
            created_at: "2026-04-20T11:00:00Z",
            source: { type: "pull_request", pull_request: { number: 23 } },
          },
        ]);
      }
      throw new Error(`unexpected url ${url}`);
    });

    const { gh, calls } = makeGh();
    const out = await handleClassifiedWebhook(asMention("status"), makeCtx(gh));

    expect(out).toEqual({
      _tag: "Ok",
      value: { kind: "replied", command: "status" },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(calls.postComment.map((call) => call.issue as unknown as number)).toEqual([42, 23]);
    expect(calls.postComment[0]?.body).toBe(calls.postComment[1]?.body);
    expect(calls.postComment[0]?.body).toContain("**Status for #42**");
  });
});
