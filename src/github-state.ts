/**
 * github-state — read durable workflow state from GitHub via the shared client boundary.
 */

import type { Logger } from "./logger.ts";
import type {
  GitHubClient,
  GitHubIssueEventRecord,
} from "./github/client.ts";
import {
  asCommentId,
  asIssueNumber,
  err,
  ok,
} from "./types.ts";
import type {
  BotUsername,
  CommentId,
  GithubStateError,
  IssueNumber,
  RepoFullName,
  Result,
} from "./types.ts";

export type IssueState = "open" | "closed";

export interface IssueSnapshot {
  readonly repo: RepoFullName;
  readonly number: IssueNumber;
  readonly state: IssueState;
  readonly labels: ReadonlyArray<string>;
  readonly assignees: ReadonlyArray<string>;
  readonly body: string;
  readonly author: string;
}

export type Claim =
  | { readonly kind: "unclaimed" }
  | { readonly kind: "claimed"; readonly by: BotUsername };

export interface GitHubStateService {
  readonly getIssue: (
    repo: RepoFullName,
    issue: IssueNumber,
  ) => Promise<Result<IssueSnapshot, GithubStateError>>;
  readonly getAgentClaim: (
    repo: RepoFullName,
    issue: IssueNumber,
    bot: BotUsername,
  ) => Promise<Result<Claim, GithubStateError>>;
  readonly listOpenIssuesWithLabel: (
    repo: RepoFullName,
    label: string,
  ) => Promise<Result<ReadonlyArray<IssueSnapshot>, GithubStateError>>;
  readonly postComment: (
    repo: RepoFullName,
    issue: IssueNumber,
    body: string,
  ) => Promise<Result<CommentId, GithubStateError>>;
  readonly getLinkedPullRequest: (
    repo: RepoFullName,
    issue: IssueNumber,
  ) => Promise<Result<IssueNumber | null, GithubStateError>>;
}

export function createGitHubStateService(
  client: Pick<GitHubClient, "getIssue" | "listIssuesWithLabel" | "listIssueEvents" | "postComment">,
  log: Logger,
): GitHubStateService {
  return {
    async getIssue(repo, issue) {
      try {
        const issueRecord = await client.getIssue(repo as string, issue as unknown as number);
        return ok(toIssueSnapshot(repo, issueRecord));
      } catch (error) {
        log.warn("github_state_get_issue_failed", { repo, issue, cause: stringifyError(error) });
        return err(toError(repo, issue, error));
      }
    },

    async getAgentClaim(repo, issue, bot) {
      const snap = await this.getIssue(repo, issue);
      if (snap._tag === "Err") return snap;
      const botStr = bot as unknown as string;
      const claimed = snap.value.assignees.includes(botStr) && snap.value.state === "open";
      return ok(claimed ? { kind: "claimed", by: bot } : { kind: "unclaimed" });
    },

    async listOpenIssuesWithLabel(repo, label) {
      try {
        const issues = await client.listIssuesWithLabel(repo as string, label);
        return ok(
          issues
            .filter((row) => !row.pullRequest)
            .map((row) => toIssueSnapshot(repo, row)),
        );
      } catch (error) {
        log.warn("github_state_list_issues_failed", { repo, label, cause: stringifyError(error) });
        return err(toError(repo, asIssueNumber(-1), error));
      }
    },

    async postComment(repo, issue, body) {
      try {
        const comment = await client.postComment(repo as string, issue as unknown as number, body);
        return ok(asCommentId(comment.id));
      } catch (error) {
        log.warn("github_state_post_comment_failed", { repo, issue, cause: stringifyError(error) });
        return err(toError(repo, issue, error));
      }
    },

    async getLinkedPullRequest(repo, issue) {
      try {
        const events = await listAllIssueEvents(client, repo, issue);
        if (events._tag === "Err") return err(events.error);
        return ok(findLinkedPullRequest(events.value));
      } catch (error) {
        log.warn("github_state_linked_pr_failed", { repo, issue, cause: stringifyError(error) });
        return err(toError(repo, issue, error));
      }
    },
  };
}

async function listAllIssueEvents(
  client: Pick<GitHubClient, "listIssueEvents">,
  repo: RepoFullName,
  issue: IssueNumber,
): Promise<Result<ReadonlyArray<GitHubIssueEventRecord>, GithubStateError>> {
  const collected: GitHubIssueEventRecord[] = [];
  for (let page = 1; ; page += 1) {
    const events = await client.listIssueEvents(repo as string, issue as unknown as number, page, 100);
    collected.push(...events);
    if (events.length < 100) {
      break;
    }
  }
  return ok(collected);
}

function findLinkedPullRequest(events: ReadonlyArray<GitHubIssueEventRecord>): IssueNumber | null {
  const latest = events
    .filter((event) => event.event === "cross-referenced" && event.sourceType === "pull_request")
    .sort((left, right) => (left.createdAt ?? "").localeCompare(right.createdAt ?? ""))
    .at(-1);
  if (latest?.sourcePullRequestNumber == null) {
    return null;
  }
  return asIssueNumber(latest.sourcePullRequestNumber);
}

function toIssueSnapshot(
  repo: RepoFullName,
  issueRecord: Awaited<ReturnType<GitHubClient["getIssue"]>>,
): IssueSnapshot {
  return {
    repo,
    number: asIssueNumber(issueRecord.number),
    state: issueRecord.state,
    labels: [...issueRecord.labels],
    assignees: [...issueRecord.assignees],
    body: issueRecord.body,
    author: issueRecord.author,
  };
}

function toError(repo: RepoFullName, issue: IssueNumber, e: unknown): GithubStateError {
  const anyErr = e as { status?: number; message?: string };
  if (anyErr?.status === 404) return { _tag: "IssueNotFound", repo, issue };
  return { _tag: "GitHubApiFailed", status: anyErr?.status ?? -1, message: anyErr?.message ?? String(e) };
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
