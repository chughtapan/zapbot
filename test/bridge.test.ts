import { describe, it, expect, beforeEach } from "vitest";
import { Effect } from "effect";
import {
  handleClassifiedWebhook,
  type BridgeConfig,
  type BridgeHandlerContext,
  type GhAdapter,
  type RepoRoute,
} from "../src/bridge.ts";
import type { ClassifiedWebhook } from "../src/gateway.ts";
import type { OrchestratorError } from "../src/orchestrator/errors.ts";
import type { TurnSuccessResponse } from "../src/orchestrator/server.ts";
import type { DispatchTurnRequest } from "../src/orchestrator/dispatcher.ts";
import {
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

interface FakeDispatchCalls {
  turns: Array<DispatchTurnRequest>;
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

type DispatchTurnFn = (
  req: DispatchTurnRequest,
) => Effect.Effect<TurnSuccessResponse, OrchestratorError, never>;

function makeDispatchTurn(opts: {
  response?: TurnSuccessResponse;
  fail?: OrchestratorError;
} = {}): { dispatchTurn: DispatchTurnFn; calls: FakeDispatchCalls } {
  const calls: FakeDispatchCalls = { turns: [] };
  const dispatchTurn: DispatchTurnFn = (req) =>
    Effect.gen(function* () {
      calls.turns.push(req);
      if (opts.fail !== undefined) {
        return yield* Effect.fail(opts.fail);
      }
      return (
        opts.response ?? {
          tag: "Replied",
          newSessionId: "session-from-orchestrator",
          durationMs: 42,
        }
      );
    });
  return { dispatchTurn, calls };
}

function makeConfig(withRoute = true): BridgeConfig {
  const repos = new Map<RepoFullName, RepoRoute>();
  if (withRoute) {
    repos.set(repo, {
      projectName: asProjectName("app"),
      webhookSecretEnvVar: "ZAPBOT_WEBHOOK_SECRET",
      defaultBranch: "main",
    });
  }
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
    orchestratorUrl: "http://127.0.0.1:3002",
    orchestratorSecret: "test-orchestrator-secret",
  };
}

function makeCtx(
  gh: GhAdapter,
  opts: {
    mintToken?: () => Promise<Result<InstallationToken, DispatchError>>;
    withRoute?: boolean;
    dispatchTurn?: DispatchTurnFn;
  } = {}
): BridgeHandlerContext {
  return {
    mintToken: opts.mintToken ?? (async () => ok("fake-token" as unknown as InstallationToken)),
    gh,
    dispatchTurn: opts.dispatchTurn ?? makeDispatchTurn().dispatchTurn,
    config: makeConfig(opts.withRoute ?? true),
  };
}

function mentionWebhook(command: ClassifiedWebhook extends infer _ ? never : never): never {
  throw command;
}
void mentionWebhook;

function asMention(kind: "plan_this" | "investigate_this" | "status" | "unknown_command", raw?: string): ClassifiedWebhook {
  const command =
    kind === "unknown_command"
      ? { kind: "unknown_command" as const, raw: raw ?? "frobnicate" }
      : { kind };
  return {
    kind: "mention_command",
    repo,
    issue,
    commentId,
    commentBody: raw ?? "@zapbot plan this",
    deliveryId: asDeliveryId("delivery-1"),
    command,
    triggeredBy: "carol",
  };
}

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
    const out = await handleClassifiedWebhook(asMention("plan_this"), makeCtx(gh));
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
    const out = await handleClassifiedWebhook(asMention("plan_this"), makeCtx(made.gh));
    expect(out._tag).toBe("Ok");
    if (out._tag === "Ok" && out.value.kind === "unauthorized") {
      expect(out.value.reason).toBe("permission_check_failed");
    }
    expect(made.calls.postComment.length).toBe(1);
    expect(made.calls.postComment[0].body).toContain("couldn't verify");
  });
});

describe("handleClassifiedWebhook — plan_this / investigate_this", () => {
  it("project not configured → ProjectNotConfigured error", async () => {
    const { gh } = makeGh({});
    const out = await handleClassifiedWebhook(asMention("plan_this"), makeCtx(gh, { withRoute: false }));
    expect(out._tag).toBe("Err");
    if (out._tag === "Err") expect(out.error._tag).toBe("ProjectNotConfigured");
  });

  it("dispatches a turn to the orchestrator and preserves raw metadata", async () => {
    const { gh, calls: ghCalls } = makeGh({});
    const { dispatchTurn, calls } = makeDispatchTurn();
    const out = await handleClassifiedWebhook(
      asMention("investigate_this", "please investigate this"),
      makeCtx(gh, { dispatchTurn }),
    );
    expect(out._tag).toBe("Ok");
    if (out._tag === "Ok") {
      expect(out.value.kind).toBe("dispatched");
      if (out.value.kind === "dispatched") {
        expect(out.value.session).toBe("session-from-orchestrator");
      }
    }
    expect(calls.turns).toHaveLength(1);
    const turn = calls.turns[0];
    expect(turn.projectSlug).toBe("app");
    expect(turn.deliveryId).toBe("delivery-1");
    expect(turn.githubToken).toBe("fake-token");
    expect(turn.message).toContain("GitHub control for acme/app#42");
    expect(turn.message).toContain("delivery_id: delivery-1");
    expect(turn.message).toContain("github_comment_body:");
    expect(turn.message).toContain("please investigate this");
    expect(ghCalls.postComment[0].body).toContain("Dispatched control event");
  });
});

describe("handleClassifiedWebhook — status command", () => {
  it("returns replied outcome tagged with 'status' and posts a summary", async () => {
    // getIssue() will fail in test env (no GitHub creds). summarizeIssue
    // returns a "Could not fetch" string, which is still posted. The outcome
    // must be `replied` with command: "status" — not `ignored`.
    const { gh, calls } = makeGh({});
    const out = await handleClassifiedWebhook(asMention("status"), makeCtx(gh));
    expect(out._tag).toBe("Ok");
    if (out._tag === "Ok") {
      expect(out.value.kind).toBe("replied");
      if (out.value.kind === "replied") expect(out.value.command).toBe("status");
    }
    // Post fired (possibly after the summary fetch — either way, called exactly once).
    expect(calls.postComment.length).toBe(1);
  });
});

describe("handleClassifiedWebhook — unknown_command", () => {
  it("returns replied outcome and posts a help comment citing the raw command", async () => {
    const { gh, calls } = makeGh({});
    const out = await handleClassifiedWebhook(asMention("unknown_command", "frobnicate"), makeCtx(gh));
    expect(out._tag).toBe("Ok");
    if (out._tag === "Ok") {
      expect(out.value.kind).toBe("replied");
      if (out.value.kind === "replied") expect(out.value.command).toBe("unknown_command");
    }
    expect(calls.postComment.length).toBe(1);
    expect(calls.postComment[0].body).toContain("frobnicate");
    expect(calls.postComment[0].body).toContain("plan this");
  });
});

describe("handleClassifiedWebhook — eyes reaction", () => {
  it("fires addReaction on any mention_command (fire-and-forget)", async () => {
    const { gh, calls } = makeGh({});
    await handleClassifiedWebhook(asMention("status"), makeCtx(gh));
    // addReaction runs async and fire-and-forget — give it a microtask to resolve.
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.addReaction.length).toBe(1);
    expect(calls.addReaction[0].reaction).toBe("eyes");
  });
});
