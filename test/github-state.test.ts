import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitHubStateService } from "../src/github-state.ts";
import type {
  GitHubClient,
  GitHubIssueEventRecord,
  GitHubIssueRecord,
} from "../src/github/client.ts";
import {
  asBotUsername,
  asIssueNumber,
  asRepoFullName,
} from "../src/types.ts";
import { createLogger } from "../src/logger.ts";

const repo = asRepoFullName("acme/app");
const issue = asIssueNumber(42);

interface FakeClientState {
  issues: ReadonlyArray<GitHubIssueRecord>;
  issueRecord: GitHubIssueRecord;
  issueEvents: ReadonlyArray<ReadonlyArray<GitHubIssueEventRecord>>;
}

let state: FakeClientState;

function makeService() {
  const client: Pick<GitHubClient, "getIssue" | "listIssuesWithLabel" | "listIssueEvents" | "postComment"> = {
    getIssue: async () => state.issueRecord,
    listIssuesWithLabel: async () => state.issues,
    listIssueEvents: async (_repo, _issueNumber, page) => state.issueEvents[page - 1] ?? [],
    postComment: async () => ({ id: 99 }),
  };
  return createGitHubStateService(client, createLogger("github-state-test", "info"));
}

beforeEach(() => {
  state = {
    issueRecord: {
      number: 42,
      state: "open",
      labels: ["bug", "docs"],
      assignees: ["zapbot[bot]", "alice"],
      body: "hi",
      author: "carol",
      pullRequest: false,
    },
    issues: [],
    issueEvents: [],
  };
});

afterEach(() => {
  state = {
    issueRecord: {
      number: 42,
      state: "open",
      labels: [],
      assignees: [],
      body: "",
      author: "",
      pullRequest: false,
    },
    issues: [],
    issueEvents: [],
  };
});

describe("GitHubStateService", () => {
  it("returns a mapped snapshot on getIssue", async () => {
    const result = await makeService().getIssue(repo, issue);
    expect(result._tag).toBe("Ok");
    if (result._tag === "Ok") {
      expect(result.value.labels).toEqual(["bug", "docs"]);
      expect(result.value.assignees).toEqual(["zapbot[bot]", "alice"]);
    }
  });

  it("returns claimed when the bot is assigned", async () => {
    const result = await makeService().getAgentClaim(repo, issue, asBotUsername("zapbot[bot]"));
    expect(result).toEqual({
      _tag: "Ok",
      value: { kind: "claimed", by: "zapbot[bot]" },
    });
  });

  it("filters out pull requests when listing issues", async () => {
    state.issues = [
      {
        number: 1,
        state: "open",
        labels: ["bug"],
        assignees: [],
        body: "",
        author: "a",
        pullRequest: false,
      },
      {
        number: 2,
        state: "open",
        labels: ["bug"],
        assignees: [],
        body: "",
        author: "b",
        pullRequest: true,
      },
    ];
    const result = await makeService().listOpenIssuesWithLabel(repo, "bug");
    expect(result._tag).toBe("Ok");
    if (result._tag === "Ok") {
      expect(result.value.map((row) => row.number)).toEqual([1]);
    }
  });

  it("returns the latest linked pull request number", async () => {
    state.issueEvents = [
      [
        {
          event: "cross-referenced",
          createdAt: "2026-04-20T10:00:00Z",
          sourceType: "pull_request",
          sourcePullRequestNumber: 17,
          sourceIssueNumber: null,
        },
        ...Array.from({ length: 99 }, (_, index) => ({
          event: "labeled",
          createdAt: `2026-04-20T10:${String(index % 60).padStart(2, "0")}:00Z`,
          sourceType: null,
          sourcePullRequestNumber: null,
          sourceIssueNumber: null,
        })),
      ],
      [
        {
          event: "cross-referenced",
          createdAt: "2026-04-20T11:00:00Z",
          sourceType: "pull_request",
          sourcePullRequestNumber: 23,
          sourceIssueNumber: null,
        },
      ],
    ];

    const result = await makeService().getLinkedPullRequest(repo, issue);
    expect(result).toEqual({
      _tag: "Ok",
      value: 23,
    });
  });
});
