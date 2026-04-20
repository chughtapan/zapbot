/**
 * github-state — read durable workflow state from GitHub via Octokit.
 *
 * Architect Open Question 2 default B: Octokit directly, not the `gh` CLI.
 */

import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import { readFileSync } from "fs";
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

export interface CommentSnapshot {
  readonly id: CommentId;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
}

export type Claim =
  | { readonly kind: "unclaimed" }
  | { readonly kind: "claimed"; readonly by: BotUsername };

function splitRepo(repo: RepoFullName): { owner: string; repo: string } {
  const [owner, name] = (repo as unknown as string).split("/");
  return { owner, repo: name };
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

export async function getIssue(
  repo: RepoFullName,
  issue: IssueNumber
): Promise<Result<IssueSnapshot, GithubStateError>> {
  const client = getOctokit();
  if (client === null) return err({ _tag: "GitHubAuthMissing" });
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
  } catch (e) {
    return err(toError(repo, issue, e));
  }
}

export async function getAgentClaim(
  repo: RepoFullName,
  issue: IssueNumber,
  bot: BotUsername
): Promise<Result<Claim, GithubStateError>> {
  const snap = await getIssue(repo, issue);
  if (snap._tag === "Err") return snap;
  const botStr = bot as unknown as string;
  const claimed = snap.value.assignees.includes(botStr) && snap.value.state === "open";
  if (claimed) return ok({ kind: "claimed", by: bot });
  return ok({ kind: "unclaimed" });
}

export async function listOpenIssuesWithLabel(
  repo: RepoFullName,
  label: string
): Promise<Result<ReadonlyArray<IssueSnapshot>, GithubStateError>> {
  const client = getOctokit();
  if (client === null) return err({ _tag: "GitHubAuthMissing" });
  const r = splitRepo(repo);
  try {
    const { data } = await client.rest.issues.listForRepo({
      owner: r.owner,
      repo: r.repo,
      state: "open",
      labels: label,
      per_page: 100,
    });
    const snaps: IssueSnapshot[] = data
      .filter((row) => !row.pull_request)
      .map((row) => ({
        repo,
        number: asIssueNumber(row.number),
        state: (row.state === "closed" ? "closed" : "open") as IssueState,
        labels: extractLabels(row.labels ?? []),
        assignees: extractAssignees(row.assignees ?? null),
        body: row.body ?? "",
        author: row.user?.login ?? "",
      }));
    return ok(snaps);
  } catch (e) {
    return err(toError(repo, asIssueNumber(-1), e));
  }
}

export async function postComment(
  repo: RepoFullName,
  issue: IssueNumber,
  body: string
): Promise<Result<CommentId, GithubStateError>> {
  const client = getOctokit();
  if (client === null) return err({ _tag: "GitHubAuthMissing" });
  const r = splitRepo(repo);
  try {
    const { data } = await client.rest.issues.createComment({
      owner: r.owner,
      repo: r.repo,
      issue_number: issue as unknown as number,
      body,
    });
    return ok(asCommentId(data.id));
  } catch (e) {
    return err(toError(repo, issue, e));
  }
}

// ── Octokit wiring ──────────────────────────────────────────────────

let _client: Octokit | null = null;

function getOctokit(): Octokit | null {
  if (_client !== null) return _client;
  _client = buildOctokit();
  return _client;
}

function buildOctokit(): Octokit | null {
  const appId = process.env.GITHUB_APP_ID;
  if (appId) {
    const installationId = process.env.GITHUB_APP_INSTALLATION_ID;
    if (!installationId) return null;
    const privateKey = loadPrivateKey();
    if (privateKey === null) return null;
    return new Octokit({
      authStrategy: createAppAuth,
      auth: { appId, privateKey, installationId },
    });
  }
  const pat = process.env.ZAPBOT_GITHUB_TOKEN;
  if (pat) return new Octokit({ auth: pat });
  return null;
}

function loadPrivateKey(): string | null {
  const keyOrPath = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!keyOrPath) return null;
  if (keyOrPath.startsWith("-----BEGIN")) return keyOrPath;
  try {
    return readFileSync(keyOrPath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Test-only: reset the memoized client. Not part of the public API.
 */
export function __resetForTests(): void {
  _client = null;
}
