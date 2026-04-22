/**
 * github-state — read durable workflow state from GitHub via Octokit.
 */

import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import type { GitHubAuthConfig } from "./config/schema.ts";
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
import type { Logger } from "./logger.ts";

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

interface IssueEventSourcePullRequest {
  readonly number?: number | null;
}

interface IssueEventSource {
  readonly type?: string | null;
  readonly pull_request?: IssueEventSourcePullRequest | null;
  readonly issue?: { readonly number?: number | null } | null;
}

interface IssueEventSnapshot {
  readonly event?: string | null;
  readonly created_at?: string | null;
  readonly source?: IssueEventSource | null;
}

interface JsonObject {
  readonly [key: string]: unknown;
}

export function createGitHubStateService(
  auth: GitHubAuthConfig,
  log: Logger,
): GitHubStateService {
  const client = buildOctokit(auth);

  return {
    async getIssue(repo, issue) {
      const r = splitRepo(repo);
      try {
        const { data } = await client.rest.issues.get({
          owner: r.owner,
          repo: r.repo,
          issue_number: issue as unknown as number,
        });
        return ok({
          repo,
          number: issue,
          state: data.state === "closed" ? "closed" : "open",
          labels: extractLabels(data.labels ?? []),
          assignees: extractAssignees(data.assignees ?? null),
          body: data.body ?? "",
          author: data.user?.login ?? "",
        });
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
      const r = splitRepo(repo);
      try {
        const { data } = await client.rest.issues.listForRepo({
          owner: r.owner,
          repo: r.repo,
          state: "open",
          labels: label,
          per_page: 100,
        });
        return ok(
          data
            .filter((row) => !row.pull_request)
            .map((row) => ({
              repo,
              number: asIssueNumber(row.number),
              state: (row.state === "closed" ? "closed" : "open") as IssueState,
              labels: extractLabels(row.labels ?? []),
              assignees: extractAssignees(row.assignees ?? null),
              body: row.body ?? "",
              author: row.user?.login ?? "",
            })),
        );
      } catch (error) {
        log.warn("github_state_list_issues_failed", { repo, label, cause: stringifyError(error) });
        return err(toError(repo, asIssueNumber(-1), error));
      }
    },

    async postComment(repo, issue, body) {
      const r = splitRepo(repo);
      try {
        const { data } = await client.rest.issues.createComment({
          owner: r.owner,
          repo: r.repo,
          issue_number: issue as unknown as number,
          body,
        });
        return ok(asCommentId(data.id));
      } catch (error) {
        log.warn("github_state_post_comment_failed", { repo, issue, cause: stringifyError(error) });
        return err(toError(repo, issue, error));
      }
    },

    async getLinkedPullRequest(repo, issue) {
      const r = splitRepo(repo);
      try {
        const events = await listAllIssueEvents(client, r.owner, r.repo, issue as unknown as number);
        if (events._tag === "Err") return err(events.error);
        return ok(findLinkedPullRequest(events.value));
      } catch (error) {
        log.warn("github_state_linked_pr_failed", { repo, issue, cause: stringifyError(error) });
        return err(toError(repo, issue, error));
      }
    },
  };
}

function splitRepo(repo: RepoFullName): { owner: string; repo: string } {
  const [owner, name] = (repo as unknown as string).split("/");
  return { owner, repo: name };
}

function buildOctokit(auth: GitHubAuthConfig): Octokit {
  switch (auth._tag) {
    case "GitHubPat":
      return new Octokit({ auth: auth.token });
    case "GitHubApp":
      return new Octokit({
        authStrategy: createAppAuth,
        auth: {
          appId: auth.appId,
          installationId: auth.installationId,
          privateKey: auth.privateKeyPem,
        },
      });
    default:
      return absurd(auth);
  }
}

function toError(repo: RepoFullName, issue: IssueNumber, e: unknown): GithubStateError {
  const anyErr = e as { status?: number; message?: string };
  if (anyErr?.status === 404) return { _tag: "IssueNotFound", repo, issue };
  return { _tag: "GitHubApiFailed", status: anyErr?.status ?? -1, message: anyErr?.message ?? String(e) };
}

function extractLabels(labels: Array<string | { name?: string | null }>): string[] {
  return labels
    .map((l) => (typeof l === "string" ? l : l.name ?? ""))
    .filter((s) => s !== "");
}

function extractAssignees(assignees: Array<{ login: string } | null> | null): string[] {
  return (assignees ?? [])
    .map((a) => a?.login ?? "")
    .filter((s) => s !== "");
}

async function listAllIssueEvents(
  client: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<Result<ReadonlyArray<IssueEventSnapshot>, GithubStateError>> {
  const collected: IssueEventSnapshot[] = [];
  for (let page = 1; ; page += 1) {
    const response = await client.rest.issues.listEvents({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
      page,
    });
    const decoded = decodeIssueEventPage(response.data);
    if (decoded._tag === "Err") return err(decoded.error);
    collected.push(...decoded.value);
    if (response.data.length < 100) break;
  }
  return ok(collected);
}

function decodeIssueEventPage(data: unknown): Result<ReadonlyArray<IssueEventSnapshot>, GithubStateError> {
  if (!Array.isArray(data)) {
    return err({ _tag: "GitHubApiFailed", status: -1, message: "issue events payload was not an array" });
  }
  const events: IssueEventSnapshot[] = [];
  for (const entry of data) {
    const decoded = decodeIssueEvent(entry);
    if (decoded._tag === "Err") return decoded;
    events.push(decoded.value);
  }
  return ok(events);
}

function decodeIssueEvent(entry: unknown): Result<IssueEventSnapshot, GithubStateError> {
  if (!isJsonObject(entry)) {
    return err({ _tag: "GitHubApiFailed", status: -1, message: "issue event entry was not an object" });
  }
  const event = decodeOptionalString(entry.event, "issue event entry had invalid event");
  if (event._tag === "Err") return event;
  const createdAt = decodeOptionalString(entry.created_at, "issue event entry had invalid created_at");
  if (createdAt._tag === "Err") return createdAt;
  const source = decodeIssueEventSource(entry.source);
  if (source._tag === "Err") return source;
  return ok({
    event: event.value,
    created_at: createdAt.value,
    source: source.value,
  });
}

function decodeIssueEventSource(value: unknown): Result<IssueEventSource | null, GithubStateError> {
  if (value === undefined || value === null) {
    return ok(null);
  }
  if (!isJsonObject(value)) {
    return err({ _tag: "GitHubApiFailed", status: -1, message: "issue event entry had invalid source" });
  }

  const type = decodeOptionalString(value.type, "issue event source had invalid type");
  if (type._tag === "Err") return type;

  let issue: { readonly number?: number | null } | undefined = undefined;
  if (value.issue !== undefined && value.issue !== null) {
    if (!isJsonObject(value.issue)) {
      return err({ _tag: "GitHubApiFailed", status: -1, message: "issue event source had invalid issue" });
    }
    const number = decodeOptionalNumber(value.issue.number, "issue event source issue had invalid number");
    if (number._tag === "Err") return number;
    issue = { number: number.value };
  }

  let pullRequest: IssueEventSourcePullRequest | undefined = undefined;
  if (value.pull_request !== undefined && value.pull_request !== null) {
    if (!isJsonObject(value.pull_request)) {
      return err({ _tag: "GitHubApiFailed", status: -1, message: "issue event source had invalid pull_request" });
    }
    const number = decodeOptionalNumber(value.pull_request.number, "issue event source pull_request had invalid number");
    if (number._tag === "Err") return number;
    pullRequest = { number: number.value };
  }

  return ok({
    type: type.value,
    issue,
    pull_request: pullRequest,
  });
}

function decodeOptionalString(
  value: unknown,
  message: string,
): Result<string | null | undefined, GithubStateError> {
  if (value === undefined || value === null) return ok(value);
  if (typeof value === "string") return ok(value);
  return err({ _tag: "GitHubApiFailed", status: -1, message });
}

function decodeOptionalNumber(
  value: unknown,
  message: string,
): Result<number | null | undefined, GithubStateError> {
  if (value === undefined || value === null) return ok(value);
  if (typeof value === "number") return ok(value);
  return err({ _tag: "GitHubApiFailed", status: -1, message });
}

function findLinkedPullRequest(events: ReadonlyArray<IssueEventSnapshot>): IssueNumber | null {
  let latestAt = Number.NEGATIVE_INFINITY;
  let linked: IssueNumber | null = null;
  for (const event of events) {
    if (event.event !== "cross-referenced") continue;
    const pullRequest = extractPullRequestNumber(event.source);
    if (pullRequest === null) continue;
    const createdAt = event.created_at ? Date.parse(event.created_at) : Number.NaN;
    if (Number.isNaN(createdAt)) continue;
    if (createdAt >= latestAt) {
      latestAt = createdAt;
      linked = pullRequest;
    }
  }
  return linked;
}

function extractPullRequestNumber(source: IssueEventSource | null | undefined): IssueNumber | null {
  if (!source) return null;
  if (source.type !== undefined && source.type !== null && source.type !== "pull_request") {
    return null;
  }
  const number = source.pull_request?.number ?? source.issue?.number ?? null;
  if (typeof number !== "number") return null;
  return asIssueNumber(number);
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object";
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function absurd(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
