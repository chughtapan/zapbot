import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createGitHubStateService } from "../src/github-state.ts";
import {
  asBotUsername,
  asIssueNumber,
  asRepoFullName,
} from "../src/types.ts";
import { createLogger } from "../src/logger.ts";

const repo = asRepoFullName("acme/app");
const issue = asIssueNumber(42);

const originalFetch = globalThis.fetch;

function installFetchStub(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  }) as typeof globalThis.fetch;
}

function makeService() {
  return createGitHubStateService(
    { _tag: "GitHubPat", token: "fake-token" },
    createLogger("github-state-test", "info"),
  );
}

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("GitHubStateService", () => {
  it("returns a mapped snapshot on getIssue", async () => {
    installFetchStub(() =>
      Response.json({
        number: 42,
        state: "open",
        labels: [{ name: "bug" }, "docs"],
        assignees: [{ login: "zapbot[bot]" }, { login: "alice" }],
        body: "hi",
        user: { login: "carol" },
      }),
    );
    const service = makeService();
    const result = await service.getIssue(repo, issue);
    expect(result._tag).toBe("Ok");
    if (result._tag === "Ok") {
      expect(result.value.labels).toEqual(["bug", "docs"]);
      expect(result.value.assignees).toEqual(["zapbot[bot]", "alice"]);
    }
  });

  it("returns claimed when the bot is assigned", async () => {
    installFetchStub(() =>
      Response.json({
        number: 42,
        state: "open",
        labels: [],
        assignees: [{ login: "zapbot[bot]" }],
        body: "",
        user: { login: "carol" },
      }),
    );
    const result = await makeService().getAgentClaim(repo, issue, asBotUsername("zapbot[bot]"));
    expect(result).toEqual({
      _tag: "Ok",
      value: { kind: "claimed", by: "zapbot[bot]" },
    });
  });

  it("filters out pull requests when listing issues", async () => {
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
      ]),
    );
    const result = await makeService().listOpenIssuesWithLabel(repo, "bug");
    expect(result._tag).toBe("Ok");
    if (result._tag === "Ok") {
      expect(result.value.map((row) => row.number)).toEqual([1]);
    }
  });

  it("returns the latest linked pull request number", async () => {
    installFetchStub((url) => {
      const parsedUrl = new URL(url);
      if (parsedUrl.pathname.includes("/issues/42/events") && parsedUrl.searchParams.get("page") === "1") {
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
      if (parsedUrl.pathname.includes("/issues/42/events") && parsedUrl.searchParams.get("page") === "2") {
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

    const result = await makeService().getLinkedPullRequest(repo, issue);
    expect(result).toEqual({
      _tag: "Ok",
      value: 23,
    });
  });
});
