/**
 * shared types — branded IDs, discriminated command shapes, typed error tags.
 */

// ── Branded identifiers ─────────────────────────────────────────────

export type RepoFullName = string & { readonly __brand: "RepoFullName" };
export type IssueNumber = number & { readonly __brand: "IssueNumber" };
export type CommentId = number & { readonly __brand: "CommentId" };
export type DeliveryId = string & { readonly __brand: "DeliveryId" };
export type ProjectName = string & { readonly __brand: "ProjectName" };
export type InstallationToken = string & { readonly __brand: "InstallationToken" };
export type AoSessionName = string & { readonly __brand: "AoSessionName" };
export type BotUsername = string & { readonly __brand: "BotUsername" };

// ── Result type (discriminated; errors are typed, not thrown) ───────

export type Ok<T> = { readonly _tag: "Ok"; readonly value: T };
export type Err<E> = { readonly _tag: "Err"; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { _tag: "Ok", value };
}
export function err<E>(error: E): Err<E> {
  return { _tag: "Err", error };
}

// ── Mention command (discriminated union) ───────────────────────────

export type MentionCommand =
  | { readonly kind: "plan_this" }
  | { readonly kind: "investigate_this" }
  | { readonly kind: "status" }
  | { readonly kind: "unknown_command"; readonly raw: string };

/**
 * Typed outcome for `handleClassifiedWebhook` — one tag per observable branch.
 * `replied` covers status and unknown_command (bridge posted a comment, no
 * dispatch). `ignored` is reserved for classify passthrough.
 */
export type HandleOutcome =
  | { readonly kind: "ignored"; readonly reason: string }
  | {
      readonly kind: "dispatched";
      readonly repo: RepoFullName;
      readonly session: AoSessionName;
    }
  | { readonly kind: "unauthorized"; readonly actor: string; readonly reason: string }
  | { readonly kind: "replied"; readonly command: MentionCommand["kind"] };

// ── Errors surfaced across module boundaries ────────────────────────

export type GatewayError =
  | { readonly _tag: "GatewayUnreachable"; readonly cause: string }
  | { readonly _tag: "GatewayRejected"; readonly status: number; readonly body: string }
  | { readonly _tag: "GatewayAuthMissing" };

export type WebhookIntakeError =
  | { readonly _tag: "SignatureMismatch" }
  | { readonly _tag: "PayloadShapeInvalid"; readonly reason: string }
  | { readonly _tag: "SecretMissing"; readonly repo: RepoFullName };

export type DispatchError =
  | { readonly _tag: "TokenMintFailed"; readonly cause: string }
  | { readonly _tag: "AoSpawnFailed"; readonly exitCode: number; readonly stderr: string }
  | { readonly _tag: "MoltzapProvisionFailed"; readonly cause: string }
  | { readonly _tag: "ProjectNotConfigured"; readonly repo: RepoFullName };

export type GithubStateError =
  | { readonly _tag: "GitHubAuthMissing" }
  | { readonly _tag: "GitHubApiFailed"; readonly status: number; readonly message: string }
  | { readonly _tag: "IssueNotFound"; readonly repo: RepoFullName; readonly issue: IssueNumber };

/**
 * Typed error channel for gh.* (v1 GitHub client) calls the bridge makes
 * in handleMention. These are local wrappers, not a separately versioned API.
 */
export type GhCallError = {
  readonly _tag: "GhCallFailed";
  readonly label: string;
  readonly cause: string;
};

// ── Exhaustiveness helper ───────────────────────────────────────────

export function absurd(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}

// ── Constructors (centralized branding at boundaries) ───────────────

export function asRepoFullName(s: string): RepoFullName {
  return s as RepoFullName;
}
export function asIssueNumber(n: number): IssueNumber {
  return n as IssueNumber;
}
export function asCommentId(n: number): CommentId {
  return n as CommentId;
}
export function asDeliveryId(s: string): DeliveryId {
  return s as DeliveryId;
}
export function asProjectName(s: string): ProjectName {
  return s as ProjectName;
}
export function asInstallationToken(s: string): InstallationToken {
  return s as InstallationToken;
}
export function asAoSessionName(s: string): AoSessionName {
  return s as AoSessionName;
}
export function asBotUsername(s: string): BotUsername {
  return s as BotUsername;
}
