/**
 * orchestrator/roster — per-epic roster manager: spawn / track / retire.
 *
 * Anchors: SPEC r4.1 (https://github.com/chughtapan/safer-by-default/issues/145#issuecomment-4307793815)
 *   Goal 2, Goal 9; Acceptance (a), (b), (c), (g), (i); Invariants 1-4, 9, 10.
 *
 * Boundaries owned by this module:
 *   1. Decode caller-supplied roster specs (Principle 2; Invariant 1).
 *   2. Spawn worker AO sessions with MoltZap identities, by declared role.
 *   3. Track live + retired members so `trackRoster` is idempotent-stable.
 *   4. Retire members idempotently; release allowlist entries and close peer
 *      channels before returning (Acceptance (b) bullet 5).
 *   5. Roll back partially-spawned rosters on any member failure (Acceptance
 *      (i) bullet 1); never leave partial-roster state live.
 *
 * Explicitly NOT owned here:
 *   - Numeric N ceiling. §0 frame and Goal 2: sizing is orchestrate SKILL.md
 *     doctrine, not code.
 *   - Budget enforcement. `orchestrator/budget.ts` owns the idle/token gates.
 *     This module emits `retireMember` on a `BudgetVerdict` trip; it does not
 *     compute the verdict.
 *   - Convergence selection. Invariant 7: orchestrator-only, in prose, above
 *     this module.
 *
 * Architect phase only: public surface, no implementation.
 */

import type {
  AoSessionName,
  IssueNumber,
  ProjectName,
  Result,
} from "../types.ts";
import type { SenderAllowlist } from "../moltzap/identity-allowlist.ts";
import type {
  PeerChannelKind,
  RoleTopologyError,
} from "../moltzap/role-topology.ts";
import type { SessionRole, WorkerRole } from "../moltzap/session-role.ts";
import type { MoltzapSenderId } from "../moltzap/types.ts";
import type { BudgetConfig, BudgetVerdict } from "./budget.ts";

// ── Branded IDs ─────────────────────────────────────────────────────

export type RosterId = string & { readonly __brand: "RosterId" };

export function asRosterId(s: string): RosterId {
  return s as RosterId;
}

/** The three non-orchestrator roles a roster may contain. */

// ── Public shapes ───────────────────────────────────────────────────

/**
 * The member-slot a caller declares at roster-spawn time. `displayLabel`
 * is free-form (e.g. `"architect-a"`, `"implementer-backend"`) and becomes
 * part of the member's MoltZap sender-id. The role is the typed discriminator.
 */
export interface RosterMemberSpec {
  readonly role: WorkerRole;
  readonly displayLabel: string;
}

export interface RosterSpec {
  readonly rosterId: RosterId;
  readonly issue: IssueNumber;
  readonly projectName: ProjectName;
  readonly members: readonly RosterMemberSpec[];
  readonly budget: BudgetConfig;
}

export interface RosterMember {
  readonly rosterId: RosterId;
  readonly session: AoSessionName;
  readonly senderId: MoltzapSenderId;
  readonly role: WorkerRole;
  readonly displayLabel: string;
  readonly spawnedAtMs: number;
}

/** Discriminator for why a session was retired. */
export type RetireReason =
  | { readonly _tag: "ExplicitRetire" }
  | { readonly _tag: "TaskComplete" }
  | { readonly _tag: "IdleTimeoutTripped"; readonly idleSinceMs: number }
  | { readonly _tag: "RosterBudgetTripped"; readonly verdict: BudgetVerdict };

export type RosterMemberStatus =
  | { readonly _tag: "Live"; readonly member: RosterMember }
  | {
      readonly _tag: "Retired";
      readonly member: RosterMember;
      readonly reason: RetireReason;
      readonly retiredAtMs: number;
    };

// ── Errors ──────────────────────────────────────────────────────────

export type RosterSpecDecodeError =
  | { readonly _tag: "RosterSpecShapeInvalid"; readonly reason: string }
  | { readonly _tag: "RosterMembersEmpty" }
  | { readonly _tag: "RosterDuplicateLabel"; readonly label: string }
  | { readonly _tag: "RosterMemberRoleUnknown"; readonly raw: string };

export type RosterSpawnError =
  | RosterSpecDecodeError
  | {
      readonly _tag: "MemberSpawnFailed";
      readonly role: WorkerRole;
      readonly displayLabel: string;
      readonly cause: string;
    }
  | {
      readonly _tag: "PartialSpawnRolledBack";
      readonly spawned: readonly RosterMember[];
      readonly failedAt: {
        readonly role: WorkerRole;
        readonly displayLabel: string;
      };
      readonly cause: string;
    }
  | {
      readonly _tag: "ReservedMcpKeyCollision";
      readonly key: "moltzap";
      readonly member: { readonly role: WorkerRole; readonly displayLabel: string };
    }
  | {
      readonly _tag: "AllowlistBindFailed";
      readonly cause: RoleTopologyError;
    };

export type RosterTrackError = {
  readonly _tag: "RosterNotFound";
  readonly rosterId: RosterId;
};

export type RosterRetireError =
  | { readonly _tag: "SessionNotFound"; readonly session: AoSessionName }
  | { readonly _tag: "RetireReleaseFailed"; readonly cause: string };

// ── Injection boundary (composition root) ──────────────────────────

/**
 * Low-level operations the roster manager calls. The concrete implementations
 * live downstream in `implement-staff` and wire up:
 *   - `spawnSession`: `bun run bin/ao-spawn-with-moltzap.ts` under the hood.
 *   - `retireSession`: `ao kill` + allowlist release.
 *   - `bindAllowlistFor`: `moltzap/role-topology.extendAllowlistForRole` closure.
 *   - `clock`: `Date.now`.
 *
 * All transport errors are re-packed into typed tags at this seam
 * (Principle 3). No raw throws cross the boundary.
 */
export interface RosterManagerDeps {
  readonly spawnSession: (args: {
    readonly rosterId: RosterId;
    readonly member: RosterMemberSpec;
    readonly issue: IssueNumber;
    readonly projectName: ProjectName;
    readonly peers: ReadonlyMap<WorkerRole, readonly MoltzapSenderId[]>;
  }) => Promise<
    Result<
      RosterMember,
      | Extract<RosterSpawnError, { readonly _tag: "MemberSpawnFailed" }>
      | Extract<RosterSpawnError, { readonly _tag: "ReservedMcpKeyCollision" }>
    >
  >;
  readonly retireSession: (
    session: AoSessionName,
  ) => Promise<Result<void, Extract<RosterRetireError, { readonly _tag: "RetireReleaseFailed" }>>>;
  readonly bindAllowlistFor: (
    member: RosterMember,
    peers: ReadonlyMap<WorkerRole, readonly MoltzapSenderId[]>,
  ) => Result<SenderAllowlist, RoleTopologyError>;
  readonly clock: () => number;
}

// ── Manager interface ──────────────────────────────────────────────

/**
 * Three-operation roster manager surface (Goal 2, Acceptance (b)).
 * Every operation is `async`; every failure is a typed error tag.
 */
export interface RosterManager {
  readonly spawnRoster: (
    spec: RosterSpec,
  ) => Promise<Result<readonly RosterMember[], RosterSpawnError>>;
  readonly trackRoster: (
    rosterId: RosterId,
  ) => Promise<Result<readonly RosterMemberStatus[], RosterTrackError>>;
  readonly retireMember: (
    rosterId: RosterId,
    session: AoSessionName,
    reason: RetireReason,
  ) => Promise<Result<void, RosterRetireError>>;
  readonly retireRoster: (
    rosterId: RosterId,
    reason: RetireReason,
  ) => Promise<Result<void, RosterTrackError | RosterRetireError>>;
}

// ── Public functions ────────────────────────────────────────────────

/**
 * Schema-decode a caller-supplied `unknown` into a `RosterSpec`.
 * Principle 2: this is the boundary where untyped input becomes a trusted
 * type. Malformed specs return typed errors; no partial state leaves.
 *
 * No numeric N-ceiling is enforced here. Invariant 1 and §0 frame: sizing
 * is orchestrate SKILL.md doctrine.
 */
export function decodeRosterSpec(
  input: unknown,
): Result<RosterSpec, RosterSpecDecodeError> {
  throw new Error("not implemented");
}

/**
 * Construct a live `RosterManager` bound to the injected transports.
 * Pure factory; the returned manager holds the spawned/retired map state.
 */
export function createRosterManager(deps: RosterManagerDeps): RosterManager {
  throw new Error("not implemented");
}

/**
 * Map a role-pair + channel-kind query to the sender-id allowlist entries a
 * freshly-spawned member needs. Used internally by `spawnRoster` before
 * handing off to `bindAllowlistFor`.
 */
export function resolveSpawnPeers(
  spec: RosterSpec,
  alreadySpawned: readonly RosterMember[],
  incoming: RosterMemberSpec,
): ReadonlyMap<WorkerRole, readonly MoltzapSenderId[]> {
  throw new Error("not implemented");
}

/**
 * Resolve the orchestrator routing target for a peer message whose intended
 * recipient has been retired (Invariant 9; Acceptance (d) bullet 3, (i)
 * bullet 3). The orchestrator re-dispatches the follow-up.
 */
export function resolveRetiredRecipientRoute(
  roster: readonly RosterMemberStatus[],
  orchestratorSenderId: MoltzapSenderId,
): { readonly orchestrator: MoltzapSenderId } {
  throw new Error("not implemented");
}

// ── Re-export for callers (barrel convenience) ──────────────────────
export type { PeerChannelKind };
