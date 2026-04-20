import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getIssue,
  getAgentClaim,
  listOpenIssuesWithLabel,
  postComment,
  getLinkedPullRequest,
  __resetForTests,
} from "../src/github-state.ts";
import {
  asBotUsername,
  asIssueNumber,
  asRepoFullName,
} from "../src/types.ts";

const repo = asRepoFullName("acme/app");
const issue = asIssueNumber(42);

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function installFetchStub(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  __resetForTests();
  process.env = { ...originalEnv };
  process.env.ZAPBOT_GITHUB_TOKEN = "fake-token";
  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_APP_INSTALLATION_ID;
  delete process.env.GITHUB_APP_PRIVATE_KEY;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

describe("getIssue", () => {
  it("returns a mapped snapshot on 200", async () => {
    installFetchStub(() =>
      Response.json({
        number: 42,
        state: "open",
        labels: [{ name: "bug" }, "docs"],
        assignees: [{ login: "zapbot[bot]" }, { login: "alice" }],
        body: "hi",
        user: { login: "carol" },
      })
    );
    const r = await getIssue(repo, issue);
    expect(r._tag).toBe("Ok");
    if (r._tag === "Ok") {
      expect(r.value.state).toBe("open");
      expect([...r.value.labels]).toEqual(["bug", "docs"]);
      expect([...r.value.assignees]).toEqual(["zapbot[bot]", "alice"]);
      expect(r.value.author).toBe("carol");
    }
  });

  it("returns IssueNotFound on 404", async () => {
    installFetchStub(() => new Response(JSON.stringify({ message: "not found" }), { status: 404 }));
    const r = await getIssue(repo, issue);
    expect(r._tag).toBe("Err");
    if (r._tag === "Err") expect(r.error._tag).toBe("IssueNotFound");
  });

  it("returns GitHubAuthMissing when no auth is configured", async () => {
    delete process.env.ZAPBOT_GITHUB_TOKEN;
    __resetForTests();
    const r = await getIssue(repo, issue);
    expect(r._tag).toBe("Err");
    if (r._tag === "Err") expect(r.error._tag).toBe("GitHubAuthMissing");
  });
});

describe("getAgentClaim", () => {
  it("returns claimed when bot is assigned and issue is open", async () => {
    installFetchStub(() =>
      Response.json({
        number: 42,
        state: "open",
        labels: [],
        assignees: [{ login: "zapbot[bot]" }],
        body: "",
        user: { login: "carol" },
      })
    );
    const r = await getAgentClaim(repo, issue, asBotUsername("zapbot[bot]"));
    expect(r._tag).toBe("Ok");
    if (r._tag === "Ok") expect(r.value.kind).toBe("claimed");
  });

  it("returns unclaimed when issue is closed", async () => {
    installFetchStub(() =>
      Response.json({
        number: 42,
        state: "closed",
        labels: [],
        assignees: [{ login: "zapbot[bot]" }],
        body: "",
        user: { login: "carol" },
      })
    );
    const r = await getAgentClaim(repo, issue, asBotUsername("zapbot[bot]"));
    expect(r._tag).toBe("Ok");
    if (r._tag === "Ok") expect(r.value.kind).toBe("unclaimed");
  });
});

describe("listOpenIssuesWithLabel", () => {
  it("filters out pull requests", async () => {
    installFetchStub(() =>
      Response.json([
        { number: 1, state: "open", labels: ["bug"], assignees: [], body: "", user: { login: "a" } },
        {
          number: 2,
          state: "open",
          labels: ["bug"],
          assignees: [],
          body: "",
          user: { login: "b" },
          pull_request: { url: "..." },
        },
      ])
    );
    const r = await listOpenIssuesWithLabel(repo, "bug");
    expect(r._tag).toBe("Ok");
    if (r._tag === "Ok") {
      expect(r.value.length).toBe(1);
      expect(r.value[0].number as unknown as number).toBe(1);
    }
  });
});

describe("postComment", () => {
  it("returns the created comment id", async () => {
    installFetchStub(() => Response.json({ id: 9999 }, { status: 201 }));
    const r = await postComment(repo, issue, "hello");
    expect(r._tag).toBe("Ok");
    if (r._tag === "Ok") expect(r.value as unknown as number).toBe(9999);
  });
});

describe("getLinkedPullRequest", () => {
  it("returns the latest linked pull request number from cross-reference events", async () => {
    installFetchStub((url) => {
      if (url.includes("/issues/42/events") && url.includes("page=1")) {
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
      if (url.includes("/issues/42/events") && url.includes("page=2")) {
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

    const r = await getLinkedPullRequest(repo, issue);
    expect(r._tag).toBe("Ok");
    if (r._tag === "Ok") {
      expect(r.value as unknown as number).toBe(23);
    }
  });

  it("rejects malformed issue event payloads at the boundary", async () => {
    installFetchStub((url) => {
      if (url.includes("/issues/42/events")) {
        return Response.json([
          {
            event: "cross-referenced",
            created_at: "2026-04-20T10:00:00Z",
            source: { type: "pull_request", pull_request: { number: "not-a-number" } },
          },
        ]);
      }
      throw new Error(`unexpected url ${url}`);
    });

    const r = await getLinkedPullRequest(repo, issue);
    expect(r._tag).toBe("Err");
    if (r._tag === "Err") {
      expect(r.error._tag).toBe("GitHubApiFailed");
    }
  });

  it("returns null when no linked pull request exists", async () => {
    installFetchStub(() => Response.json([]));
    const r = await getLinkedPullRequest(repo, issue);
    expect(r._tag).toBe("Ok");
    if (r._tag === "Ok") expect(r.value).toBeNull();
  });
});
