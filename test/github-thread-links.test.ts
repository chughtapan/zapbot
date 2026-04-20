import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveThreadMirrorTargets } from "../src/github/thread-links.ts";
import { __resetForTests } from "../src/github-state.ts";
import { asIssueNumber, asRepoFullName } from "../src/types.ts";

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
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

describe("resolveThreadMirrorTargets", () => {
  it("returns the canonical issue and its linked pull request", async () => {
    installFetchStub((url) => {
      if (url.includes("/issues/42") && !url.includes("/events")) {
        return Response.json({
          number: 42,
          state: "open",
          labels: [],
          assignees: [],
          body: "issue body",
          user: { login: "carol" },
        });
      }
      if (url.includes("/issues/42/events")) {
        return Response.json([
          {
            event: "cross-referenced",
            created_at: "2026-04-20T10:00:00Z",
            source: { type: "pull_request", pull_request: { number: 77 } },
          },
        ]);
      }
      throw new Error(`unexpected url ${url}`);
    });

    const r = await resolveThreadMirrorTargets({ repo, issue });
    expect(r._tag).toBe("Ok");
    if (r._tag === "Ok") {
      expect(r.value.repo).toBe(repo);
      expect(r.value.issue as unknown as number).toBe(42);
      expect(r.value.linkedPullRequest as unknown as number).toBe(77);
    }
  });
});
