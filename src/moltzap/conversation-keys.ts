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
 */

import { absurd } from "../types.ts";
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

const CONVERSATION_KEY_SET: ReadonlySet<string> = new Set<string>(
  ALL_CONVERSATION_KEYS as readonly string[],
);

// ── Role-pair directionality ────────────────────────────────────────

/**
 * For each key, the roles that may send on it and the roles that may receive
 * on it. Used to build role-scoped manifests in `manifest.ts` and to gate
 * send-time calls in `app-client.ts`.
 *
 * Invariant 6: directionality is declared here, not at the receive site.
 */
export interface RolePairBinding {
  readonly key: ConversationKey;
  readonly senders: ReadonlySet<SessionRole>;
  readonly receivers: ReadonlySet<SessionRole>;
}

/**
 * The full binding table. Every entry is referenced by at least one role's
 * manifest; every key appears exactly once.
 *
 * Exhaustiveness guard: constructed via a switch over `ConversationKey` so
 * adding a new key is a compile-time error if its row is missing.
 */
function buildBinding(key: ConversationKey): RolePairBinding {
  switch (key) {
    case "coord-orch-to-worker":
      return {
        key,
        senders: new Set<SessionRole>(["orchestrator"]),
        receivers: new Set<SessionRole>([
          "architect",
          "implementer",
          "reviewer",
        ]),
      };
    case "coord-worker-to-orch":
      return {
        key,
        senders: new Set<SessionRole>([
          "architect",
          "implementer",
          "reviewer",
        ]),
        receivers: new Set<SessionRole>(["orchestrator"]),
      };
    case "coord-architect-peer":
      return {
        key,
        senders: new Set<SessionRole>(["architect"]),
        receivers: new Set<SessionRole>(["architect"]),
      };
    case "coord-implementer-to-architect":
      return {
        key,
        senders: new Set<SessionRole>(["implementer"]),
        receivers: new Set<SessionRole>(["architect"]),
      };
    case "coord-review-to-author":
      return {
        key,
        senders: new Set<SessionRole>(["reviewer"]),
        receivers: new Set<SessionRole>(["architect", "implementer"]),
      };
    default:
      return absurd(key);
  }
}

const BINDINGS: readonly RolePairBinding[] = ALL_CONVERSATION_KEYS.map(
  buildBinding,
);

export function getRolePairBindings(): readonly RolePairBinding[] {
  return BINDINGS;
}

/**
 * Which keys a role of `role` may send on. Used to constrain
 * `sendOnKey(key, parts)` at the zapbot seam (pre-RPC). A role that calls
 * `send` with a key not in this set is rejected with `KeyDisallowedForRole`
 * before any `messages/send` RPC is attempted.
 */
export function sendableKeysForRole(
  role: SessionRole,
): ReadonlySet<ConversationKey> {
  const out = new Set<ConversationKey>();
  for (const b of BINDINGS) {
    if (b.senders.has(role)) out.add(b.key);
  }
  return out;
}

/**
 * Which keys a role of `role` may receive on. Used to decide which
 * `app.onMessage(key, handler)` registrations are allowed at boot.
 */
export function receivableKeysForRole(
  role: SessionRole,
): ReadonlySet<ConversationKey> {
  const out = new Set<ConversationKey>();
  for (const b of BINDINGS) {
    if (b.receivers.has(role)) out.add(b.key);
  }
  return out;
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
  if (typeof raw !== "string" || !CONVERSATION_KEY_SET.has(raw)) {
    return { _tag: "UnknownConversationKey", raw: String(raw) };
  }
  return raw as ConversationKey;
}
