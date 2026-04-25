/**
 * moltzap/session-role — canonical SessionRole taxonomy (closed 4-value enum).
 *
 * Anchors: SPEC r4.1 (https://github.com/chughtapan/safer-by-default/issues/145#issuecomment-4307793815)
 *   Goal 1, Invariant 2, Acceptance (a).
 *
 * Lives in its own module (rather than in `session-client.ts`) so that
 * (1) roster + peer-message can type-check at architect stage against the
 *     expanded enum,
 * (2) `implement-staff` can collapse `session-client.ts`'s binary
 *     `"orchestrator" | "worker"` into a re-export from this file without
 *     cascading churn through every caller,
 * (3) the role taxonomy stays readable without opening the session-client
 *     implementation to find it.
 */

import type { Result } from "../types.ts";
import { err, ok } from "../types.ts";

/**
 * Closed union of every role a live MoltZap session may carry. Acceptance
 * (a): every session records its role at spawn; unknown-role spawns are
 * rejected at the roster-manager boundary (see `decodeSessionRole`).
 *
 * Principle 4: every switch over `SessionRole` ends in `absurd(role)`.
 */
export type SessionRole =
  | "orchestrator"
  | "architect"
  | "implementer"
  | "reviewer";

/** Decoder for wire-level role strings. Principle 2 boundary. */
export type SessionRoleDecodeError = {
  readonly _tag: "UnknownSessionRole";
  readonly raw: string;
};

/**
 * The non-orchestrator roles a roster may contain. Derived by `Extract` so
 * adding a new non-orchestrator role to `SessionRole` widens this type
 * automatically.
 */
export type WorkerRole = Extract<
  SessionRole,
  "architect" | "implementer" | "reviewer"
>;

export const ALL_SESSION_ROLES: readonly SessionRole[] = [
  "orchestrator",
  "architect",
  "implementer",
  "reviewer",
];
export const ALL_WORKER_ROLES: readonly WorkerRole[] = [
  "architect",
  "implementer",
  "reviewer",
];

// Interned set for O(1) membership.
const SESSION_ROLE_SET: ReadonlySet<string> = new Set<string>(
  ALL_SESSION_ROLES as readonly string[],
);
const WORKER_ROLE_SET: ReadonlySet<string> = new Set<string>(
  ALL_WORKER_ROLES as readonly string[],
);

export function decodeSessionRole(
  raw: string,
): Result<SessionRole, SessionRoleDecodeError> {
  if (typeof raw !== "string" || !SESSION_ROLE_SET.has(raw)) {
    return err({ _tag: "UnknownSessionRole", raw: String(raw) });
  }
  return ok(raw as SessionRole);
}

export function isWorkerRole(role: SessionRole): role is WorkerRole {
  return WORKER_ROLE_SET.has(role);
}
