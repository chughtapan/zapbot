import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  handleClassifiedWebhook,
  startBridge,
  type BridgeConfig,
  type BridgeDependencies,
  type BridgeHandlerContext,
  type GhAdapter,
  type RepoRoute,
} from "../src/bridge.ts";
import type { ClassifiedWebhook } from "../src/gateway.ts";
import { buildEligibleMentionRequest } from "../src/github-control-request.ts";
import { asMoltzapSenderId } from "../src/moltzap/types.ts";
import type { AoControlHost } from "../src/orchestrator/runtime.ts";
import { createLogger } from "../src/logger.ts";
import {
  asAoSessionName,
  asBotUsername,
  asCommentId,
  asDeliveryId,
  asIssueNumber,
  asProjectName,
  asRepoFullName,
  err,
  ok,
} from "../src/types.ts";
import type {
  GhCallError,
  IssueNumber,
  RepoFullName,
  Result,
} from "../src/types.ts";
import type { MintedInstallationToken } from "../src/http/routes/installation-token.ts";

const repo = asRepoFullName("acme/app");
const issue = asIssueNumber(42);
const commentId = asCommentId(7);
const bot = asBotUsername("zapbot[bot]");

interface FakeGhCalls {
  addReaction: Array<{ repo: RepoFullName; commentId: number; reaction: string }>;
  getUserPermission: Array<{ repo: RepoFullName; user: string }>;
  postComment: Array<{ repo: RepoFullName; issue: IssueNumber; body: string }>;
}

interface FakeAoCalls {
  ensureStarted: Array<string>;
  resolveReady: Array<string>;
  sendPrompt: Array<{ session: string; title: string; body: string }>;
}

function makeGh(opts: {
  permission?: Result<string, GhCallError>;
  postResult?: Result<void, GhCallError>;
}): { gh: GhAdapter; calls: FakeGhCalls } {
  const calls: FakeGhCalls = { addReaction: [], getUserPermission: [], postComment: [] };
  const gh: GhAdapter = {
    addReaction: async (repo, cid, reaction) => {
      calls.addReaction.push({ repo, commentId: cid, reaction });
      return ok(undefined);
    },
    getUserPermission: async (repo, user) => {
      calls.getUserPermission.push({ repo, user });
      return opts.permission ?? ok("write");
    },
    postComment: async (repo, issue, body) => {
      calls.postComment.push({ repo, issue, body });
      return opts.postResult ?? ok(undefined);
    },
  };
  return { gh, calls };
}

function makeAoHost(): { host: AoControlHost; calls: FakeAoCalls } {
  const calls: FakeAoCalls = { ensureStarted: [], resolveReady: [], sendPrompt: [] };
  const host: AoControlHost = {
    ensureStarted: async (projectName) => {
      calls.ensureStarted.push(projectName as unknown as string);
      return ok(undefined);
    },
    resolveReady: async (projectName) => {
      calls.resolveReady.push(projectName as unknown as string);
      return ok({
        session: asAoSessionName(`${projectName as unknown as string}-orchestrator`),
        senderId: asMoltzapSenderId("orch-1"),
        mode: "reused",
      });
    },
    sendPrompt: async (session, prompt) => {
      calls.sendPrompt.push({
        session: session as unknown as string,
        title: prompt.title,
        body: prompt.body,
      });
      return ok(undefined);
    },
  };
  return { host, calls };
}

function makeConfig(withRoute = true): BridgeConfig {
  const repos = new Map<RepoFullName, RepoRoute>();
  if (withRoute) {
    repos.set(repo, {
      projectName: asProjectName("app"),
      webhookSecret: "test-webhook-secret",
      defaultBranch: "main",
    });
  }
  return {
    port: 3000,
    ingress: {
      _tag: "LocalOnly",
      mode: "local-only",
      gatewayUrl: null,
      publicUrl: null,
      requiresReachablePublicUrl: false,
    },
    publicUrl: "http://localhost:3000",
    gatewayUrl: "",
    gatewaySecret: null,
    botUsername: bot,
    aoConfigPath: "",
    apiKey: "test-broker-key",
    moltzap: { _tag: "MoltzapDisabled" },
    repos,
  };
}

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
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function makeCtx(
  gh: GhAdapter,
  opts: {
    mintToken?: () => Promise<MintedInstallationToken | null>;
    withRoute?: boolean;
    aoControlHost?: AoControlHost;
    durableComments?: Array<{ repo: RepoFullName; issue: IssueNumber; body: string }>;
  } = {}
): BridgeHandlerContext {
  return {
    mintToken: opts.mintToken ?? (async () => null),
    gh,
    githubState: {
      postComment: async (repo, issue, body) => {
        opts.durableComments?.push({ repo, issue, body });
        return ok(asCommentId(99));
      },
      getIssue: async () => ok({
        repo,
        number: issue,
        state: "open",
        labels: [],
        assignees: [],
        body: "",
        author: "carol",
      }),
      getLinkedPullRequest: async () => ok(null),
    },
    aoControlHost: opts.aoControlHost ?? makeAoHost().host,
    config: makeConfig(opts.withRoute ?? true),
    log: createLogger("bridge-test", "info"),
  };
}

function mentionWebhook(command: ClassifiedWebhook extends infer _ ? never : never): never {
  throw command;
}
void mentionWebhook;

function asMentionRequest(
  rawCommentBody = "@zapbot please plan the next lane",
  threadKind: "issue" | "pull_request" = "issue",
): ClassifiedWebhook {
  const request = buildEligibleMentionRequest({
    placement: {
      repo,
      projectName: asProjectName("app"),
      issue,
      issueThreadKind: threadKind,
      issueTitle: threadKind === "issue" ? "Plan the next lane" : "Review the PR lane",
      issueUrl: "https://github.com/acme/app/issues/42",
      commentId,
      commentUrl: "https://github.com/acme/app/issues/42#issuecomment-7",
      deliveryId: asDeliveryId("delivery-1"),
    },
    rawCommentBody,
    triggeredBy: "carol",
  });
  if (request._tag !== "Ok") {
    throw new Error(`unexpected invalid request: ${request.error._tag}`);
  }
  return {
    kind: "mention_request",
    request: request.value,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleClassifiedWebhook — ignore passthrough", () => {
  it("echoes the ignore reason without touching gh", async () => {
    const { gh, calls } = makeGh({});
    const out = await handleClassifiedWebhook({ kind: "ignore", reason: "self-mention" }, makeCtx(gh));
    expect(out._tag).toBe("Ok");
    if (out._tag === "Ok") {
      expect(out.value.kind).toBe("ignored");
      if (out.value.kind === "ignored") expect(out.value.reason).toBe("self-mention");
    }
    expect(calls.getUserPermission.length).toBe(0);
    expect(calls.postComment.length).toBe(0);
  });
});

describe("handleClassifiedWebhook — permission gate", () => {
  let gh: GhAdapter;
  let calls: FakeGhCalls;
  beforeEach(() => {
    const made = makeGh({ permission: ok("read") });
    gh = made.gh;
    calls = made.calls;
  });

  it("insufficient permission → unauthorized + comment posted", async () => {
    const out = await handleClassifiedWebhook(asMentionRequest(), makeCtx(gh));
    expect(out._tag).toBe("Ok");
    if (out._tag === "Ok") {
      expect(out.value.kind).toBe("unauthorized");
      if (out.value.kind === "unauthorized") {
        expect(out.value.actor).toBe("carol");
        expect(out.value.reason).toBe("insufficient_permission");
      }
    }
    expect(calls.postComment.length).toBe(1);
    expect(calls.postComment[0].body).toContain("write access");
  });

  it("gh.getUserPermission failure → unauthorized with permission_check_failed", async () => {
    const made = makeGh({
      permission: err({ _tag: "GhCallFailed", label: "getUserPermission", cause: "network" }),
    });
    const out = await handleClassifiedWebhook(asMentionRequest(), makeCtx(made.gh));
    expect(out._tag).toBe("Ok");
    if (out._tag === "Ok" && out.value.kind === "unauthorized") {
      expect(out.value.reason).toBe("permission_check_failed");
    }
    expect(made.calls.postComment.length).toBe(1);
    expect(made.calls.postComment[0].body).toContain("couldn't verify");
  });
});

describe("handleClassifiedWebhook — mention_request", () => {
  it("forwards control to the persistent orchestrator and preserves raw metadata", async () => {
    const { gh, calls: ghCalls } = makeGh({});
    const { host, calls } = makeAoHost();
    const durableComments: Array<{ repo: RepoFullName; issue: IssueNumber; body: string }> = [];
    const out = await handleClassifiedWebhook(
      asMentionRequest("@zapbot please investigate this failure"),
      makeCtx(gh, { aoControlHost: host, durableComments }),
    );
    expect(out._tag).toBe("Ok");
    if (out._tag === "Ok") {
      expect(out.value.kind).toBe("dispatched");
      if (out.value.kind === "dispatched") {
        expect(out.value.session).toBe("app-orchestrator");
      }
    }
    expect(calls.ensureStarted).toEqual(["app"]);
    expect(calls.resolveReady).toEqual(["app"]);
    expect(calls.sendPrompt).toHaveLength(1);
    expect(calls.sendPrompt[0].title).toContain("GitHub control for acme/app#42");
    expect(calls.sendPrompt[0].body).toContain("delivery_id: delivery-1");
    expect(calls.sendPrompt[0].body).toContain("issue_thread_kind: issue");
    expect(calls.sendPrompt[0].body).toContain("github_comment_body:");
    expect(calls.sendPrompt[0].body).toContain("please investigate this failure");
    expect(ghCalls.postComment).toHaveLength(0);
    expect(durableComments).toHaveLength(1);
    expect(durableComments[0].body).toContain("Forwarded control event");
  });

  it("accepts pull-request issue threads and forwards their placement context", async () => {
    const { gh, calls } = makeGh({});
    const { host, calls: aoCalls } = makeAoHost();
    const durableComments: Array<{ repo: RepoFullName; issue: IssueNumber; body: string }> = [];
    const out = await handleClassifiedWebhook(
      asMentionRequest("@zapbot please summarize the current PR state", "pull_request"),
      makeCtx(gh, { aoControlHost: host, durableComments }),
    );
    expect(out._tag).toBe("Ok");
    expect(calls.postComment).toHaveLength(0);
    expect(durableComments).toHaveLength(1);
    expect(aoCalls.sendPrompt).toHaveLength(1);
    expect(aoCalls.sendPrompt[0].body).toContain("issue_thread_kind: pull_request");
    expect(aoCalls.sendPrompt[0].body).toContain("please summarize the current PR state");
  });

  it("does not emit a bridge-side help fallback for arbitrary raw text", async () => {
    const { gh, calls } = makeGh({});
    const { host, calls: aoCalls } = makeAoHost();
    const durableComments: Array<{ repo: RepoFullName; issue: IssueNumber; body: string }> = [];
    const out = await handleClassifiedWebhook(
      asMentionRequest("@zapbot frobnicate the lane and decide what this means"),
      makeCtx(gh, { aoControlHost: host, durableComments }),
    );
    expect(out._tag).toBe("Ok");
    if (out._tag === "Ok") {
      expect(out.value.kind).toBe("dispatched");
    }
    expect(calls.postComment.length).toBe(0);
    expect(durableComments).toHaveLength(1);
    expect(durableComments[0].body).toContain("Forwarded control event");
    expect(aoCalls.sendPrompt[0].body).toContain("frobnicate the lane");
  });
});

describe("handleClassifiedWebhook — eyes reaction", () => {
  it("fires addReaction on any mention_request (fire-and-forget)", async () => {
    const { gh, calls } = makeGh({});
    await handleClassifiedWebhook(asMentionRequest("@zapbot please look at this"), makeCtx(gh));
    // addReaction runs async and fire-and-forget — give it a microtask to resolve.
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.addReaction.length).toBe(1);
    expect(calls.addReaction[0].reaction).toBe("eyes");
  });
});

describe("startBridge reload", () => {
  it("refreshes gh, githubState, mintToken, and aoControlHost on reload", async () => {
    let capturedFetch: ((req: Request) => Promise<Response>) | null = null;
    const stdoutWrites: string[] = [];
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    vi.spyOn(Bun, "serve").mockImplementation((((input: { readonly fetch: (req: Request) => Promise<Response> }) => {
      capturedFetch = input.fetch;
      return {
        stop() {
          return undefined;
        },
      };
    }) as typeof Bun.serve));

    try {
      const callsA = {
        permissions: [] as string[],
        durableComments: [] as string[],
        control: [] as string[],
        minted: 0,
      };
      const callsB = {
        permissions: [] as string[],
        durableComments: [] as string[],
        control: [] as string[],
        minted: 0,
      };

      const depsA = makeReloadDeps("A", callsA);
      const depsB = makeReloadDeps("B", callsB);
      const running = await startBridge(makeConfig() as never, depsA);
      if (capturedFetch === null) {
        throw new Error("expected Bun.serve fetch handler");
      }

      const firstTokenResponse = await capturedFetch(new Request("http://localhost/api/tokens/installation", {
        method: "GET",
        headers: {
          authorization: "Bearer test-broker-key",
        },
      }));
      expect(firstTokenResponse.status).toBe(200);
      expect((await firstTokenResponse.json()) as { token: string }).toMatchObject({
        token: "token-A",
      });
      expect(callsA.minted).toBe(1);
      expect(callsB.minted).toBe(0);
      expect(stdoutWrites.some((line) => line.includes("[bridge-A] installation_token.request"))).toBe(true);

      const body = JSON.stringify({
        action: "created",
        repository: { full_name: "acme/app" },
        sender: { login: "alice" },
        issue: {
          number: 42,
          title: "Plan the next lane",
          html_url: "https://github.com/acme/app/issues/42",
        },
        comment: { id: 7, body: "@zapbot please plan the next lane" },
      });
      const signature = await signPayload(body, "test-webhook-secret");
      const firstWebhookResponse = await capturedFetch(new Request("http://localhost/api/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "x-hub-signature-256": signature,
          "x-github-event": "issue_comment",
          "x-github-delivery": "delivery-a",
        },
      }));
      expect(firstWebhookResponse.status).toBe(200);
      expect(callsA.permissions).toEqual(["A"]);
      expect(callsA.durableComments).toEqual(["A"]);
      expect(callsA.control).toEqual(["A"]);
      expect(callsB.permissions).toEqual([]);

      const reloadLogOffset = stdoutWrites.length;
      await running.reload(makeConfig() as never, depsB);

      const secondTokenResponse = await capturedFetch(new Request("http://localhost/api/tokens/installation", {
        method: "GET",
        headers: {
          authorization: "Bearer test-broker-key",
        },
      }));
      expect(secondTokenResponse.status).toBe(200);
      expect((await secondTokenResponse.json()) as { token: string }).toMatchObject({
        token: "token-B",
      });
      expect(callsA.minted).toBe(1);
      expect(callsB.minted).toBe(1);
      expect(
        stdoutWrites
          .slice(reloadLogOffset)
          .some((line) => line.includes("[bridge-B] installation_token.request")),
      ).toBe(true);

      const secondWebhookResponse = await capturedFetch(new Request("http://localhost/api/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "x-hub-signature-256": signature,
          "x-github-event": "issue_comment",
          "x-github-delivery": "delivery-b",
        },
      }));
      expect(secondWebhookResponse.status).toBe(200);
      expect(callsA.permissions).toEqual(["A"]);
      expect(callsA.durableComments).toEqual(["A"]);
      expect(callsA.control).toEqual(["A"]);
      expect(callsB.permissions).toEqual(["B"]);
      expect(callsB.durableComments).toEqual(["B"]);
      expect(callsB.control).toEqual(["B"]);

      await running.stop();
    } finally {
      stdoutWrite.mockRestore();
    }
  });
});

function makeReloadDeps(
  label: string,
  calls: {
    permissions: string[];
    durableComments: string[];
    control: string[];
    minted: number;
  },
): BridgeDependencies {
  return {
    loggerFactory: {
      create(component: string) {
        return createLogger(`${component}-${label}`, "info");
      },
    },
    githubClient: {
      addLabel: async () => undefined,
      removeLabel: async () => undefined,
      postComment: async () => ({ id: 1 }),
      updateComment: async () => undefined,
      closeIssue: async () => undefined,
      createIssue: async () => "https://github.com/acme/app/issues/1",
      editIssue: async () => undefined,
      convertPrToDraft: async () => undefined,
      addReaction: async () => undefined,
      addIssueReaction: async () => undefined,
      assignIssue: async () => undefined,
      getIssue: async () => ({ number: 42, state: "open", labels: [], assignees: [], body: "", author: "alice", pullRequest: false }),
      getIssueState: async () => "open",
      getIssueBody: async () => "",
      listIssuesWithLabel: async () => [],
      listIssueEvents: async () => [],
      getUserPermission: async () => {
        calls.permissions.push(label);
        return "write";
      },
      listWebhooks: async () => [],
      createWebhook: async () => 1,
      updateWebhook: async () => undefined,
      deactivateWebhook: async () => undefined,
    },
    githubState: {
      postComment: async () => {
        calls.durableComments.push(label);
        return ok(asCommentId(99));
      },
      getIssue: async () => ok({
        repo,
        number: issue,
        state: "open",
        labels: [],
        assignees: [],
        body: "",
        author: "carol",
      }),
      getLinkedPullRequest: async () => ok(null),
    },
    mintToken: async () => {
      calls.minted += 1;
      return {
        token: `token-${label}`,
        expiresAt: "2026-04-23T00:00:00Z",
      };
    },
    createAoControlHost() {
      return {
        ensureStarted: async () => {
          calls.control.push(label);
          return ok(undefined);
        },
        resolveReady: async () => ok({
          session: asAoSessionName(`${label}-orchestrator`),
          senderId: asMoltzapSenderId(`${label}-sender`),
          mode: "reused",
        }),
        sendPrompt: async () => ok(undefined),
      };
    },
    gatewayHeartbeatMs: 300_000,
  };
}
