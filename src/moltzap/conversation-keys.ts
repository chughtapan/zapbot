/**
 * moltzap/conversation-keys — typed role-pair conversation keys.
 *
 * Anchors: sbd#170 SPEC rev 2, Invariants 2, 5, 6; §5 "one conversation key
 * per directional role-pair"; OQ #3 resolution (per-role-pair keys, no
 * receive-side defensive check).
 *
 * This module owns the finite, named set of coordination-channel keys
 * that the bridge declares in its single union `AppManifest` registered
 * with `@moltzap/app-sdk`. It is the authoritative place where role-pair
 * key NAMES live; directionality is a publisher-intent label, not a
 * server-enforced send filter.
 *
 * Rev 3 §5.5 / §8.6 reconciliation: under `participantFilter: "all"` +
 * the absence of upstream per-participant send permissions, directional
 * flow is enforced by (a) the bridge's `apps/create({invitedAgentIds})`
 * admission control, (b) the channel-plugin's reply-on-inbound
 * semantic (MCP `reply` tool targets the inbound's `chat_id`), and (c)
 * publisher-code convention — NOT by a role-scoped manifest or
 * server-side send-set. The rev 1 prose that claimed "role-scoped
 * manifest + send-set enforce the sender side" is superseded.
 *
 * Dead-key note: `coord-worker-to-orch` is retained in the set for
 * spec-churn minimization but has no organic publisher in v1 under
 * reply-on-inbound. See rev 4 §8.2 + the assertion in
 * `test/moltzap-union-manifest.test.ts`.
 *
 * Implementation stubs. Architect stage — bodies throw.
 */

import type { SessionRole } from "./session-role.ts";

// ── Keys ────────────────────────────────────────────────────────────

/**
 * Finite set of role-pair conversation keys. One key per directed role-pair
 * type per rev 2 §5 acceptance bullet. No wildcard key; no dynamic key
 * construction; every value declared here is a compile-time string literal so
 * the union is exhaustive at switch sites.
 *
 * Principle 4 handling: every switch over `ConversationKey` ends in
 * `absurd(key)`.
 */
export type ConversationKey =
  | "coord-orch-to-worker"
  // Dead key in v1 — no organic publisher under the channel-plugin's
  // reply-on-inbound semantic. Retained for manifest stability (see rev
  // 4 §8.2). Asserted zero organic publishers via the `it.todo` in
  // `test/moltzap-union-manifest.test.ts`.
  | "coord-worker-to-orch"
  | "coord-architect-peer"
  | "coord-implementer-to-architect"
  | "coord-review-to-author";

export const ALL_CONVERSATION_KEYS: readonly ConversationKey[] = [
  "coord-orch-to-worker",
  "coord-worker-to-orch",
  "coord-architect-peer",
  "coord-implementer-to-architect",
  "coord-review-to-author",
];

// ── Role-pair directionality ────────────────────────────────────────

/**
 * For each key, the roles that conventionally publish on it and the
 * roles that conventionally receive on it. **Client-convention only**:
 * v1 does not project role-scoped manifests and does not ship a
 * send-side gate. The table remains useful for documentation,
 * roster-builder bookkeeping, and any future per-role MCP transport
 * scoping that lands outside sbd#199's scope.
 *
 * Rev 4 §8.6: directionality is not server-enforced. The rev 1 claim
 * that "the send-set + the role-scoped manifest registered with the
 * server enforce the sender side" is superseded — there is no
 * role-scoped manifest in v1 (union manifest only), and there is no
 * server-side per-participant send filter.
 */
export interface RolePairBinding {
  readonly key: ConversationKey;
  readonly senders: ReadonlySet<SessionRole>;
  readonly receivers: ReadonlySet<SessionRole>;
}

/**
 * The full binding table. Every entry is referenced by at least one role's
 * manifest; every key appears exactly once.
 */
export function getRolePairBindings(): readonly RolePairBinding[] {
  throw new Error("not implemented");
}

/**
 * Which keys a role of `role` may send on. Used to constrain
 * `ZapbotMoltZapApp.send(key, parts)` at the zapbot seam (pre-RPC). A role
 * that calls `send` with a key not in this set is rejected with
 * `KeyDisallowedForRole` before any `messages/send` RPC is attempted.
 */
export function sendableKeysForRole(
  role: SessionRole,
): ReadonlySet<ConversationKey> {
  throw new Error("not implemented");
}

/**
 * Which keys a role of `role` may receive on. Used to decide which
 * `app.onMessage(key, handler)` registrations are allowed at boot in
 * `app-client.ts`.
 */
export function receivableKeysForRole(
  role: SessionRole,
): ReadonlySet<ConversationKey> {
  throw new Error("not implemented");
}

// ── Decode ──────────────────────────────────────────────────────────

export type ConversationKeyDecodeError = {
  readonly _tag: "UnknownConversationKey";
  readonly raw: string;
};

/** Principle 2 boundary: wire string → typed key. */
export function decodeConversationKey(
  raw: string,
): ConversationKey | ConversationKeyDecodeError {
  throw new Error("not implemented");
}
