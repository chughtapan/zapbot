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
 */

import type { Result } from "../types.ts";
import { absurd, err, ok } from "../types.ts";
import { fromSenderIds, type SenderAllowlist } from "./identity-allowlist.ts";
import {
  ALL_SESSION_ROLES,
  decodeSessionRole,
  type SessionRole,
} from "./session-role.ts";
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

export const ALL_PEER_CHANNEL_KINDS: readonly PeerChannelKind[] = [
  "orchestrator-to-worker",
  "worker-to-orchestrator",
  "architect-peer",
  "implementer-to-architect",
  "review-to-author",
];

const PEER_CHANNEL_KIND_SET: ReadonlySet<string> = new Set<string>(
  ALL_PEER_CHANNEL_KINDS as readonly string[],
);

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
 *
 * Principle 4: exhaustive over SessionRole.
 */
export function channelsForRole(role: SessionRole): ReadonlySet<PeerChannelKind> {
  switch (role) {
    case "orchestrator":
      // Orchestrator both sends to workers and receives from them.
      return new Set<PeerChannelKind>([
        "orchestrator-to-worker",
        "worker-to-orchestrator",
        // Also the final routing destination when a review follow-up's
        // author has been retired (Invariant 9).
        "review-to-author",
        "implementer-to-architect",
      ]);
    case "architect":
      return new Set<PeerChannelKind>([
        "orchestrator-to-worker",
        "worker-to-orchestrator",
        "architect-peer",
        "implementer-to-architect",
        "review-to-author",
      ]);
    case "implementer":
      return new Set<PeerChannelKind>([
        "orchestrator-to-worker",
        "worker-to-orchestrator",
        "implementer-to-architect",
        "review-to-author",
      ]);
    case "reviewer":
      return new Set<PeerChannelKind>([
        "orchestrator-to-worker",
        "worker-to-orchestrator",
        "review-to-author",
      ]);
    default:
      return absurd(role);
  }
}

/**
 * Predicate: may a session-pair `(from, to)` transmit on `kind`?
 * Returns `Ok(void)` if allowed; `Err(RolePairDisallowed)` otherwise.
 *
 * Disallowed pairs (not explicitly tabulated):
 *   - architect ↔ implementer direct (must go through orchestrator)
 *   - architect ↔ reviewer direct (must go through orchestrator)
 *   - implementer ↔ implementer, reviewer ↔ reviewer (no peer-sideways among
 *     same non-architect role)
 *
 * Principle 4: exhaustive over PeerChannelKind.
 */
export function allowsRolePair(
  kind: PeerChannelKind,
  pair: RolePair,
): Result<void, RoleTopologyError> {
  const disallow = (): Result<void, RoleTopologyError> =>
    err({ _tag: "RolePairDisallowed", kind, pair });

  switch (kind) {
    case "orchestrator-to-worker":
      if (pair.from !== "orchestrator") return disallow();
      if (pair.to === "orchestrator") return disallow();
      return ok(undefined);
    case "worker-to-orchestrator":
      if (pair.to !== "orchestrator") return disallow();
      if (pair.from === "orchestrator") return disallow();
      return ok(undefined);
    case "architect-peer":
      if (pair.from !== "architect" || pair.to !== "architect") return disallow();
      return ok(undefined);
    case "implementer-to-architect":
      if (pair.from !== "implementer" || pair.to !== "architect") return disallow();
      return ok(undefined);
    case "review-to-author":
      if (pair.from !== "reviewer") return disallow();
      // Author can be architect or implementer. Reviewer→reviewer is not an
      // authorship follow-up; reviewer→orchestrator is covered by
      // worker-to-orchestrator.
      if (pair.to !== "architect" && pair.to !== "implementer") return disallow();
      return ok(undefined);
    default:
      return absurd(kind);
  }
}

/**
 * Extend an existing `SenderAllowlist` with the sender-ids of the peers
 * a newly-spawned `role` session is entitled to talk to. Called at roster
 * spawn time, after every member's `MoltzapSenderId` is known, before any
 * peer-message leaves the session (Invariant 3, allowlist-before-transmit).
 *
 * Returns a fresh, frozen `SenderAllowlist` — the union of the base
 * allowlist's entries and every `peers` entry whose key is a role this
 * session is allowed to receive from per channelsForRole.
 *
 * The input is not mutated; the returned allowlist is the only reference
 * callers need.
 */
export function extendAllowlistForRole(
  base: SenderAllowlist,
  role: SessionRole,
  peers: ReadonlyMap<SessionRole, readonly MoltzapSenderId[]>,
): SenderAllowlist {
  // Pull the opaque Set out of the base allowlist by round-tripping through
  // fromSenderIds. identity-allowlist intentionally hides the underlying
  // Set behind a symbol; read it via the construction path only.
  const baseIds = getAllowlistIds(base);
  const merged = new Set<MoltzapSenderId>(baseIds);

  const allowedChannels = channelsForRole(role);

  for (const [peerRole, ids] of peers) {
    if (!peerMayReachRole(role, peerRole, allowedChannels)) continue;
    for (const id of ids) merged.add(id);
  }

  return fromSenderIds([...merged]);
}

/**
 * Read back the sender-id set from a SenderAllowlist. Uses the same Symbol
 * the identity-allowlist module uses internally. Kept local because the
 * extension function is the only boundary that needs both "construct" and
 * "inspect"; other callers treat SenderAllowlist as opaque.
 */
function getAllowlistIds(list: SenderAllowlist): ReadonlySet<MoltzapSenderId> {
  // Find the unique symbol key on the frozen handle; identity-allowlist
  // assigns exactly one symbol-valued property to the allowlist object.
  const syms = Object.getOwnPropertySymbols(list);
  for (const s of syms) {
    const val = (list as unknown as Record<symbol, unknown>)[s];
    if (val instanceof Set) {
      return val as ReadonlySet<MoltzapSenderId>;
    }
  }
  return new Set<MoltzapSenderId>();
}

/**
 * Whether a session of `role` may receive messages from a peer of
 * `peerRole`, by checking the peer's permitted send-channels against the
 * local role's receive-channels. Used to decide which peers to include in
 * the allowlist extension.
 */
function peerMayReachRole(
  role: SessionRole,
  peerRole: SessionRole,
  localChannels: ReadonlySet<PeerChannelKind>,
): boolean {
  for (const kind of ALL_PEER_CHANNEL_KINDS) {
    if (!localChannels.has(kind)) continue;
    const res = allowsRolePair(kind, { from: peerRole, to: role });
    if (res._tag === "Ok") return true;
  }
  return false;
}

/**
 * Decode a raw channel-kind tag from the wire. Used by `peer-message.ts`
 * after schema-decoding a peer message body (Principle 2, boundary decode).
 */
export function decodeChannelKind(raw: string): Result<PeerChannelKind, RoleTopologyError> {
  if (typeof raw !== "string" || !PEER_CHANNEL_KIND_SET.has(raw)) {
    return err({ _tag: "ChannelKindUnknown", raw: String(raw) });
  }
  return ok(raw as PeerChannelKind);
}

/**
 * Decode a raw role string; convenience re-export for use in contexts that
 * want `UnknownRole` tagging consistent with the topology error union.
 */
export function decodeRoleOrTopologyError(
  raw: string,
): Result<SessionRole, RoleTopologyError> {
  const res = decodeSessionRole(raw);
  if (res._tag === "Err") {
    return err({ _tag: "UnknownRole", raw: res.error.raw });
  }
  return ok(res.value);
}

export { ALL_SESSION_ROLES };
