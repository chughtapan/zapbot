/**
 * v2/github-state — read durable workflow state from GitHub via `gh`.
 *
 * Replaces v1's SQLite `workflows` / `agent_sessions` / `transitions` tables.
 * Spec invariant 2: GitHub is the record. Every read here is a `gh` shell
 * call (or the Octokit equivalent) against the live repo; nothing is
 * cached across process restart.
 *
 * Principle 2 (Validate at every boundary): every call's return value is
 * decoded at the boundary from `gh`'s JSON output into the branded types
 * declared here. No `Record<string, unknown>` on the public surface.
 */

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

/**
 * Read current state of an issue. Fails if `gh` is missing or the issue
 * does not exist. Does NOT retry — the caller's concern.
 */
export function getIssue(
  _repo: RepoFullName,
  _issue: IssueNumber
): Promise<Result<IssueSnapshot, GithubStateError>> {
  throw new Error("not implemented");
}

/**
 * Does this issue already have an agent working on it? Implemented as:
 * "is the bot an assignee AND is the issue open." No local cache.
 * The two possible answers are modeled as a discriminated union so callers
 * cannot conflate "not claimed" with "query failed."
 */
export type Claim =
  | { readonly kind: "unclaimed" }
  | { readonly kind: "claimed"; readonly by: BotUsername };

export function getAgentClaim(
  _repo: RepoFullName,
  _issue: IssueNumber,
  _bot: BotUsername
): Promise<Result<Claim, GithubStateError>> {
  throw new Error("not implemented");
}

/**
 * List open issues in `repo` that carry `label`. Used by the bridge's
 * startup recovery (if any): "what issues were the bot dispatched on and
 * haven't closed yet." v1 derived this from SQLite; v2 derives it from
 * GitHub.
 */
export function listOpenIssuesWithLabel(
  _repo: RepoFullName,
  _label: string
): Promise<Result<ReadonlyArray<IssueSnapshot>, GithubStateError>> {
  throw new Error("not implemented");
}

/**
 * Post a comment as the bot. `installationToken` is resolved upstream by
 * `v2/github-auth` (which wraps the existing `src/github/client.ts` token
 * mint — not re-architected in v2). Returns the new comment's id so
 * downstream code can edit it if needed.
 */
export function postComment(
  _repo: RepoFullName,
  _issue: IssueNumber,
  _body: string
): Promise<Result<CommentId, GithubStateError>> {
  throw new Error("not implemented");
}
