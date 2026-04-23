/**
 * moltzap/role-topology — per-role peer-channel topology + allowlist extension.
 *
 * Anchors: SPEC r4.1 (https://github.com/chughtapan/safer-by-default/issues/145#issuecomment-4307793815)
 *   Goal 3, Invariant 7, Acceptance (c).
 *
 * Responsibility: own the role-pair predicates that decide which peer channels
 * a session of a given role may open, and bind those predicates to the
 * sender-identity allowlist at roster spawn time.
 *
 * This module does NOT decide convergence. Convergence selection is
 * orchestrator-only (Invariant 7). No peer-channel carries vote-tally or
 * winner-declaration fields; that rule lives in `peer-message.ts` kinds and
 * in `/safer:review-senior` SKILL.md doctrine.
 *
 * Architect phase only: public surface, no implementation.
 */

import type { Result } from "../types.ts";
import { type SenderAllowlist } from "./identity-allowlist.ts";
import type { SessionRole } from "./session-client.ts";
import type { MoltzapSenderId } from "./types.ts";

// ── Peer-channel kinds ──────────────────────────────────────────────
//
// Closed union. Every kind names a role-pair direction. The discriminant
// `kind` is what `peer-message.ts` routes on; this module owns the
// topology predicate only.

export type PeerChannelKind =
  | "orchestrator-to-worker"
  | "worker-to-orchestrator"
  | "architect-peer"
  | "implementer-to-architect"
  | "review-to-author";

export interface RolePair {
  readonly from: SessionRole;
  readonly to: SessionRole;
}

// ── Errors ──────────────────────────────────────────────────────────

export type RoleTopologyError =
  | { readonly _tag: "RolePairDisallowed"; readonly kind: PeerChannelKind; readonly pair: RolePair }
  | { readonly _tag: "ChannelKindUnknown"; readonly raw: string }
  | { readonly _tag: "UnknownRole"; readonly raw: string };

// ── Public surface ──────────────────────────────────────────────────

/**
 * The finite set of peer-channel kinds a session of `role` may open.
 * Used at spawn time to derive the allowlist extension shape and at
 * send time to gate the pair-direction check.
 */
export function channelsForRole(role: SessionRole): ReadonlySet<PeerChannelKind> {
  throw new Error("not implemented");
}

/**
 * Predicate: may a session-pair `(from, to)` transmit on `kind`?
 * Returns `Ok(void)` if allowed; `Err(RolePairDisallowed)` otherwise.
 *
 * The absence of a peer-sideways pair (architect <-> implementer,
 * reviewer <-> reviewer, implementer <-> implementer) is encoded here,
 * not in `peer-message.ts`. Principle 4: exhaustiveness over the closed
 * role set.
 */
export function allowsRolePair(
  kind: PeerChannelKind,
  pair: RolePair,
): Result<void, RoleTopologyError> {
  throw new Error("not implemented");
}

/**
 * Extend an existing `SenderAllowlist` with the sender-ids of the peers
 * a newly-spawned `role` session is entitled to talk to. Called at roster
 * spawn time, after every member's `MoltzapSenderId` is known, before any
 * peer-message leaves the session (Invariant 3, allowlist-before-transmit).
 *
 * Returns a fresh, frozen `SenderAllowlist`. The input is not mutated.
 */
export function extendAllowlistForRole(
  base: SenderAllowlist,
  role: SessionRole,
  peers: ReadonlyMap<SessionRole, readonly MoltzapSenderId[]>,
): SenderAllowlist {
  throw new Error("not implemented");
}

/**
 * Decode a raw channel-kind tag from the wire. Used by `peer-message.ts`
 * after schema-decoding a peer message body (Principle 2, boundary decode).
 */
export function decodeChannelKind(raw: string): Result<PeerChannelKind, RoleTopologyError> {
  throw new Error("not implemented");
}
