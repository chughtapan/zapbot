/**
 * v2 shared types — branded IDs, discriminated command shapes, typed error tags.
 *
 * Downstream rule: every public function in v2/ declares its parameter types
 * and error channel from this file. No raw `string` for identifiers on a
 * public signature. No `Promise<T>` for fallible calls — use `Result<T, E>`
 * with a discriminated `E`.
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

export function ok<T>(_value: T): Ok<T> {
  throw new Error("not implemented");
}
export function err<E>(_error: E): Err<E> {
  throw new Error("not implemented");
}

// ── Mention command (discriminated union) ───────────────────────────

/**
 * Parsed `@zapbot <command>` intent. `unknown_command` carries the raw text
 * so the bridge can respond with a "I don't recognize that command" comment
 * without embedding its own command vocabulary here.
 */
export type MentionCommand =
  | { readonly kind: "plan_this" }
  | { readonly kind: "investigate_this" }
  | { readonly kind: "status" }
  | { readonly kind: "unknown_command"; readonly raw: string };

// ── Errors surfaced across module boundaries ────────────────────────

export type GatewayError =
  | { readonly _tag: "GatewayUnreachable"; readonly cause: string }
  | { readonly _tag: "GatewayRejected"; readonly status: number; readonly body: string }
  | { readonly _tag: "GatewayAuthMissing" };

export type WebhookIntakeError =
  | { readonly _tag: "InvalidJson" }
  | { readonly _tag: "SignatureMismatch" }
  | { readonly _tag: "UnconfiguredRepo"; readonly repo: RepoFullName }
  | { readonly _tag: "SecretMissing"; readonly repo: RepoFullName };

export type DispatchError =
  | { readonly _tag: "TokenMintFailed"; readonly cause: string }
  | { readonly _tag: "AoSpawnFailed"; readonly exitCode: number; readonly stderr: string }
  | { readonly _tag: "ProjectNotConfigured"; readonly repo: RepoFullName };

export type GithubStateError =
  | { readonly _tag: "GhCliMissing" }
  | { readonly _tag: "GhCliFailed"; readonly exitCode: number; readonly stderr: string }
  | { readonly _tag: "IssueNotFound"; readonly repo: RepoFullName; readonly issue: IssueNumber }
  | { readonly _tag: "ParseFailed"; readonly raw: string };

// ── Exhaustiveness helper ───────────────────────────────────────────

export function absurd(_x: never): never {
  throw new Error("not implemented");
}
