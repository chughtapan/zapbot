/**
 * moltzap/conversation-keys — typed role-pair conversation keys.
 *
 * Anchors: sbd#170 SPEC rev 2, Invariants 2, 5, 6; §5 "one conversation key
 * per directional role-pair"; OQ #3 resolution (per-role-pair keys, no
 * receive-side defensive check).
 *
 * This module owns the finite, named set of coordination-channel keys that
 * zapbot declares in every `AppManifest` registered with `@moltzap/app-sdk`.
 * It is the single authoritative place where role-pair directionality is
 * encoded; role-scoped manifests (src/moltzap/manifest.ts) project a subset
 * of this set per `SessionRole`.
 *
 * Invariant 6 (verbatim): "the conversation key carries the role-pair; the
 * receiver trusts the key, not a role field in the payload body." This module
 * declares the key set; `manifest.ts` binds each key to the roles that may
 * send/receive on it.
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
 * For each key, the roles that may send on it and the roles that may receive
 * on it. Used to build role-scoped manifests in `manifest.ts` and to gate
 * send-time calls in `app-client.ts`.
 *
 * Invariant 6: directionality is declared here, not at the receive site.
 * Receivers trust the key; the send-set + the role-scoped manifest registered
 * with the server enforce the sender side.
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
