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
 * OQ1 resolution: `RosterId` is caller-supplied (epic-number-derived, e.g.
 * `roster-145-r1`). Uniqueness is enforced by orchestrate SKILL.md, not
 * here; `decodeRosterSpec` accepts any non-empty string.
 */

import type {
  AoSessionName,
  IssueNumber,
  ProjectName,
  Result,
} from "../types.ts";
import { absurd, asIssueNumber, asProjectName, err, ok } from "../types.ts";
import {
  decodeSessionRole,
  type WorkerRole,
} from "../moltzap/session-role.ts";
import type { MoltzapSenderId } from "../moltzap/types.ts";
import type {
  BudgetConfig,
  BudgetEvent,
  BudgetState,
  BudgetVerdict,
  TokenCount,
  WallClockMs,
} from "./budget.ts";
import {
  applyBudgetEvent,
  asIdleSeconds,
  asTokenCount,
  asWallClockMs,
  checkBudget,
  initialBudgetState,
  retireScopeFor,
} from "./budget.ts";

// ── Branded IDs ─────────────────────────────────────────────────────

export type RosterId = string & { readonly __brand: "RosterId" };

export function asRosterId(s: string): RosterId {
  return s as RosterId;
}

// ── Public shapes ───────────────────────────────────────────────────

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

/**
 * Architect rev 4 §4.3: ONE bridge session is created per roster (invited =
 * union of all worker senderIds), BEFORE any worker is spawned. This error
 * surfaces failures of that prepare phase so the roster manager can report
 * them as a normal `MemberSpawnFailed` (with the first member as the
 * stand-in role/label) without inventing a new caller-facing error tag —
 * callers downstream of `spawnRoster` already handle MemberSpawnFailed.
 */
export type RosterSessionPrepareError = {
  readonly _tag: "RosterSessionPrepareFailed";
  readonly cause: string;
};

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
    };

export type RosterTrackError = {
  readonly _tag: "RosterNotFound";
  readonly rosterId: RosterId;
};

export type RosterRetireError =
  | { readonly _tag: "SessionNotFound"; readonly session: AoSessionName }
  | { readonly _tag: "RetireReleaseFailed"; readonly cause: string };

// ── Injection boundary ──────────────────────────────────────────────

export interface RosterManagerDeps {
  /**
   * Architect rev 4 §4.3 prepare phase. Called ONCE per roster before any
   * `spawnSession`. Implementations register all worker creds and create
   * exactly one bridge session whose `invitedAgentIds` is the union of
   * worker senderIds, then wait for admission to complete. Per-roster
   * state (the bridgeSessionId, premised credentials by displayLabel)
   * lives inside the implementation; `RosterManager` does not introspect
   * it.
   *
   * Implementations that don't need a prepare phase (e.g. tests, the
   * transitional `moltzapAuth: null` path) return `Ok(undefined)`.
   */
  readonly prepareRosterSession: (args: {
    readonly rosterId: RosterId;
    readonly members: readonly RosterMemberSpec[];
    readonly issue: IssueNumber;
    readonly projectName: ProjectName;
  }) => Promise<Result<void, RosterSessionPrepareError>>;
  readonly spawnSession: (args: {
    readonly rosterId: RosterId;
    readonly member: RosterMemberSpec;
    readonly issue: IssueNumber;
    readonly projectName: ProjectName;
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
  /**
   * Best-effort close of the per-roster bridge session and removal of any
   * roster-scoped state held by the implementation. Called by `spawnRoster`
   * after a failed-spawn rollback (so a half-prepared roster does not
   * leak its bridge session) and by `retireRoster` after the last member
   * is retired (so the bridge session lifetime tracks the roster's, per
   * architect rev 4 §4.3). Failures are the implementation's to log; the
   * roster manager surfaces no error channel here because retire/cleanup
   * paths must remain best-effort.
   */
  readonly releaseRosterSession: (rosterId: RosterId) => Promise<void>;
  readonly clock: () => number;
}

// ── Manager interface ──────────────────────────────────────────────

/**
 * Outcome of a single `stepBudget` evaluation. Surfaces the verdict
 * and the retire that was applied (if any), so callers can log/audit.
 * Principle 4: exhaustive over every path the roster manager takes.
 */
export type BudgetStepOutcome =
  | { readonly _tag: "WithinBudget" }
  | {
      readonly _tag: "MemberRetired";
      readonly session: AoSessionName;
      readonly verdict: BudgetVerdict;
    }
  | {
      readonly _tag: "RosterRetired";
      readonly rosterId: RosterId;
      readonly verdict: BudgetVerdict;
    }
  | {
      readonly _tag: "StepFailed";
      readonly reason: RosterTrackError | RosterRetireError;
    };

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

  // ── Budget-event ingestion (SPEC §5(g); Invariant 6) ───────────────
  //
  // The roster manager owns the per-roster BudgetState. Callers fold
  // events in through these methods; `stepBudget` evaluates both gates
  // and applies any retire the verdict implies (code-level enforcement,
  // per SPEC §5(g) "code, not policy").

  readonly recordPeerMessageObserved: (
    rosterId: RosterId,
    session: AoSessionName,
    atMs: WallClockMs,
  ) => Result<void, RosterTrackError>;
  readonly recordTokensConsumed: (
    rosterId: RosterId,
    session: AoSessionName,
    tokens: TokenCount,
  ) => Result<void, RosterTrackError>;
  readonly stepBudget: (
    rosterId: RosterId,
    nowMs: WallClockMs,
  ) => Promise<BudgetStepOutcome>;

  /**
   * List every roster currently tracked (live or partially retired).
   * Exposed so bridge-side coordinators can iterate active rosters
   * without knowing individual rosterIds up-front — e.g. a peer-
   * message inbound observer applies `recordPeerMessageObserved` to
   * whichever roster owns the `session`.
   */
  readonly listActiveRosterIds: () => readonly RosterId[];

  /**
   * Find the rosterId that owns a session, if any. Returns null if
   * the session is not tracked by any roster. Used by ingress
   * observers to route events to the right roster without threading
   * rosterId through every call site.
   */
  readonly findRosterForSession: (
    session: AoSessionName,
  ) => RosterId | null;
}

// ── Decoder ────────────────────────────────────────────────────────

function shapeInvalid(reason: string): RosterSpecDecodeError {
  return { _tag: "RosterSpecShapeInvalid", reason };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

export function decodeRosterSpec(
  input: unknown,
): Result<RosterSpec, RosterSpecDecodeError> {
  if (!isPlainObject(input)) {
    return err(shapeInvalid("roster spec must be a JSON object"));
  }

  const rosterIdRaw = input.rosterId;
  if (typeof rosterIdRaw !== "string" || rosterIdRaw.length === 0) {
    return err(shapeInvalid("field `rosterId` must be a non-empty string"));
  }

  const issueRaw = input.issue;
  if (
    typeof issueRaw !== "number" ||
    !Number.isInteger(issueRaw) ||
    issueRaw <= 0
  ) {
    return err(shapeInvalid("field `issue` must be a positive integer"));
  }

  const projectRaw = input.projectName;
  if (typeof projectRaw !== "string" || projectRaw.length === 0) {
    return err(shapeInvalid("field `projectName` must be a non-empty string"));
  }

  const membersRaw = input.members;
  if (!Array.isArray(membersRaw)) {
    return err(shapeInvalid("field `members` must be an array"));
  }
  if (membersRaw.length === 0) {
    return err({ _tag: "RosterMembersEmpty" });
  }

  const seenLabels = new Set<string>();
  const members: RosterMemberSpec[] = [];
  for (let i = 0; i < membersRaw.length; i++) {
    const m = membersRaw[i];
    if (!isPlainObject(m)) {
      return err(shapeInvalid(`members[${i}] must be an object`));
    }
    const roleRaw = m.role;
    if (typeof roleRaw !== "string") {
      return err(shapeInvalid(`members[${i}].role must be a string`));
    }
    const roleDecoded = decodeSessionRole(roleRaw);
    if (roleDecoded._tag === "Err") {
      return err({ _tag: "RosterMemberRoleUnknown", raw: roleDecoded.error.raw });
    }
    if (roleDecoded.value === "orchestrator") {
      return err({ _tag: "RosterMemberRoleUnknown", raw: "orchestrator" });
    }
    const labelRaw = m.displayLabel;
    if (typeof labelRaw !== "string" || labelRaw.length === 0) {
      return err(
        shapeInvalid(`members[${i}].displayLabel must be a non-empty string`),
      );
    }
    if (seenLabels.has(labelRaw)) {
      return err({ _tag: "RosterDuplicateLabel", label: labelRaw });
    }
    seenLabels.add(labelRaw);
    members.push({
      role: roleDecoded.value as WorkerRole,
      displayLabel: labelRaw,
    });
  }

  const budgetRaw = input.budget;
  if (!isPlainObject(budgetRaw)) {
    return err(shapeInvalid("field `budget` must be an object"));
  }
  const idle = budgetRaw.sessionIdleSeconds;
  const tokens = budgetRaw.rosterBudgetTokens;
  const declared = budgetRaw.declaredMemberCount;
  if (typeof idle !== "number" || !Number.isInteger(idle) || idle <= 0) {
    return err(shapeInvalid("budget.sessionIdleSeconds must be a positive integer"));
  }
  if (typeof tokens !== "number" || !Number.isInteger(tokens) || tokens <= 0) {
    return err(shapeInvalid("budget.rosterBudgetTokens must be a positive integer"));
  }
  if (typeof declared !== "number" || !Number.isInteger(declared) || declared <= 0) {
    return err(shapeInvalid("budget.declaredMemberCount must be a positive integer"));
  }

  return ok({
    rosterId: asRosterId(rosterIdRaw),
    issue: asIssueNumber(issueRaw),
    projectName: asProjectName(projectRaw),
    members,
    budget: {
      sessionIdleSeconds: asIdleSeconds(idle),
      rosterBudgetTokens: asTokenCount(tokens),
      declaredMemberCount: declared,
    },
  });
}

// ── Factory ────────────────────────────────────────────────────────

interface RosterRecord {
  readonly rosterId: RosterId;
  readonly spec: RosterSpec;
  readonly statuses: Map<AoSessionName, RosterMemberStatus>;
  budgetState: BudgetState;
}

export function createRosterManager(deps: RosterManagerDeps): RosterManager {
  const rosters = new Map<RosterId, RosterRecord>();

  async function rollback(
    spawned: readonly RosterMember[],
  ): Promise<string | null> {
    const releaseErrors: string[] = [];
    for (const m of spawned) {
      const res = await deps.retireSession(m.session);
      if (res._tag === "Err") {
        releaseErrors.push(`${m.session as string}:${res.error.cause}`);
      }
    }
    return releaseErrors.length === 0 ? null : releaseErrors.join("; ");
  }

  async function spawnRoster(
    spec: RosterSpec,
  ): Promise<Result<readonly RosterMember[], RosterSpawnError>> {
    // Validate reserved labels BEFORE the prepare phase. The reserved-key
    // guard (Invariant 4) used to live inside `spawnSession`, but with
    // `prepareRosterSession` registering MoltZap workers + creating a
    // bridge session in front of `spawnSession`, an invalid label would
    // mint server-side credentials before the guard rejected it.
    for (const memberSpec of spec.members) {
      if (
        memberSpec.displayLabel === "moltzap" ||
        memberSpec.displayLabel.startsWith("moltzap-reserved-")
      ) {
        return err({
          _tag: "ReservedMcpKeyCollision",
          key: "moltzap",
          member: {
            role: memberSpec.role,
            displayLabel: memberSpec.displayLabel,
          },
        });
      }
    }

    // Architect rev 4 §4.3 prepare phase: ONE bridge session per roster,
    // invited-list = union of all worker senderIds. Per-spawn sessions
    // would create per-worker conversation IDs, so workers in the same
    // roster could not exchange messages on shared `coord-*` keys.
    const prepared = await deps.prepareRosterSession({
      rosterId: spec.rosterId,
      members: spec.members,
      issue: spec.issue,
      projectName: spec.projectName,
    });
    if (prepared._tag === "Err") {
      // Cause-the-string surfaces the typed prepare-failure tag for
      // operator-visible distinction (registration failed vs admission
      // timed out); private typed detail stays inside the dep impl.
      const head = spec.members[0];
      // Defensive: decoder rejects empty members, but the type permits a
      // zero-length array — surface a stable error tag rather than throw.
      if (head === undefined) {
        return err({
          _tag: "MemberSpawnFailed",
          role: "implementer",
          displayLabel: "<roster-prepare>",
          cause: prepared.error.cause,
        });
      }
      // Best-effort: even if prepare reported failure, the impl may have
      // partially allocated state (e.g. registered workers before the
      // bridge session create failed). Release ensures cleanup.
      await deps.releaseRosterSession(spec.rosterId);
      return err({
        _tag: "MemberSpawnFailed",
        role: head.role,
        displayLabel: head.displayLabel,
        cause: prepared.error.cause,
      });
    }

    const spawned: RosterMember[] = [];

    for (const memberSpec of spec.members) {
      const res = await deps.spawnSession({
        rosterId: spec.rosterId,
        member: memberSpec,
        issue: spec.issue,
        projectName: spec.projectName,
      });
      if (res._tag === "Err") {
        const cleanupErr = await rollback(spawned);
        // Always release the per-roster bridge session after rollback;
        // when no member spawned, the rollback retired nothing and the
        // bridge session would leak otherwise (architect rev 4 §4.3).
        await deps.releaseRosterSession(spec.rosterId);
        const errTag = res.error._tag;
        if (errTag === "ReservedMcpKeyCollision") {
          // Reserved-key collision is a typed error in its own right
          // (Invariant 4). Rollback is still performed; if rollback itself
          // failed, surface that via a PartialSpawnRolledBack wrapping the
          // collision cause — silently dropping rollback errors would leak
          // partial-roster state.
          if (cleanupErr !== null && spawned.length > 0) {
            return err({
              _tag: "PartialSpawnRolledBack",
              spawned,
              failedAt: {
                role: memberSpec.role,
                displayLabel: memberSpec.displayLabel,
              },
              cause: `ReservedMcpKeyCollision on key "moltzap"; rollback errors: ${cleanupErr}`,
            });
          }
          return err({
            _tag: "ReservedMcpKeyCollision",
            key: "moltzap",
            member: res.error.member,
          });
        }
        const cause =
          cleanupErr === null
            ? res.error.cause
            : `${res.error.cause}; rollback errors: ${cleanupErr}`;
        if (spawned.length === 0) {
          return err({
            _tag: "MemberSpawnFailed",
            role: memberSpec.role,
            displayLabel: memberSpec.displayLabel,
            cause,
          });
        }
        return err({
          _tag: "PartialSpawnRolledBack",
          spawned,
          failedAt: {
            role: memberSpec.role,
            displayLabel: memberSpec.displayLabel,
          },
          cause,
        });
      }
      spawned.push(res.value);
    }

    // sbd#201: client-side allowlist binding is gone. Admission lives
    // server-side: the spawn dep calls `createBridgeSession` with
    // `invitedAgentIds: [thisWorkerSenderId]` BEFORE each `ao spawn`, so
    // the bridge's `apps/create` invite admits the worker on every
    // conversation key in the union manifest. Role-pair topology is
    // dissolved into role-pair conversation keys (`conversation-keys.ts`).

    // Register roster once all members are up.
    const statuses = new Map<AoSessionName, RosterMemberStatus>();
    for (const m of spawned) {
      statuses.set(m.session, { _tag: "Live", member: m });
    }
    // Seed the two-gate budget state machine. `deps.clock()` returns ms.
    const spawnNowMs = asWallClockMs(deps.clock());
    const budgetState = initialBudgetState(
      spec.budget,
      spawned.map((m) => m.session),
      spawnNowMs,
    );
    rosters.set(spec.rosterId, {
      rosterId: spec.rosterId,
      spec,
      statuses,
      budgetState,
    });

    return ok(spawned);
  }

  async function trackRoster(
    rosterId: RosterId,
  ): Promise<Result<readonly RosterMemberStatus[], RosterTrackError>> {
    const rec = rosters.get(rosterId);
    if (!rec) return err({ _tag: "RosterNotFound", rosterId });
    return ok([...rec.statuses.values()]);
  }

  async function retireMember(
    rosterId: RosterId,
    session: AoSessionName,
    reason: RetireReason,
  ): Promise<Result<void, RosterRetireError>> {
    const rec = rosters.get(rosterId);
    if (!rec) {
      // trackRoster returns RosterNotFound for unknown rosters; but
      // retireMember's error channel only knows session-level failures.
      // An unknown roster manifests as SessionNotFound: the session can't
      // be part of a roster we don't track.
      return err({ _tag: "SessionNotFound", session });
    }
    const current = rec.statuses.get(session);
    if (!current) {
      return err({ _tag: "SessionNotFound", session });
    }
    // Idempotent: retiring an already-retired member returns Ok without
    // re-invoking the underlying retire (Acceptance (b) bullet 5).
    if (current._tag === "Retired") {
      return ok(undefined);
    }
    // TOCTOU fix (stamina round 3 #8): claim-and-mark Retired BEFORE
    // the await. Two overlapping `retireMember` or `stepBudget` calls
    // were both seeing _tag==="Live", both invoking deps.retireSession,
    // and both flipping state afterwards — double-retire. Now the
    // second caller sees Retired before the first's await resolves and
    // short-circuits (idempotent). We use a sentinel retiredAtMs=0
    // while the retire is in-flight; the real retiredAtMs is written
    // once deps.retireSession resolves so telemetry is accurate.
    const retireInFlight: RosterMemberStatus = {
      _tag: "Retired",
      member: current.member,
      reason,
      retiredAtMs: 0,
    };
    rec.statuses.set(session, retireInFlight);
    const release = await deps.retireSession(session);
    if (release._tag === "Err") {
      // Roll back the sentinel so a retry is possible. Leave the
      // MemberRetired budget-event UN-applied until a successful
      // release — otherwise the budget state desyncs from reality.
      rec.statuses.set(session, current);
      return err(release.error);
    }
    const retiredAtMs = deps.clock();
    rec.statuses.set(session, {
      _tag: "Retired",
      member: current.member,
      reason,
      retiredAtMs,
    });
    // Fold the MemberRetired event so checkBudget stops counting this
    // session's idle clock and stops attributing tokens to a retired
    // member (SPEC §5(g); Invariant 6).
    rec.budgetState = applyBudgetEvent(rec.budgetState, {
      _tag: "MemberRetired",
      session,
      atMs: asWallClockMs(retiredAtMs),
    });
    return ok(undefined);
  }

  async function retireRoster(
    rosterId: RosterId,
    reason: RetireReason,
  ): Promise<Result<void, RosterTrackError | RosterRetireError>> {
    const rec = rosters.get(rosterId);
    if (!rec) return err({ _tag: "RosterNotFound", rosterId });
    for (const [session, status] of [...rec.statuses.entries()]) {
      if (status._tag === "Retired") continue;
      const res = await retireMember(rosterId, session, reason);
      if (res._tag === "Err") return err(res.error);
    }
    // Architect rev 4 §4.3: bridge session lifetime tracks the roster's,
    // not the per-worker session's. Close the bridge session AFTER every
    // member is down so admission is revoked + the session's
    // `apps/closeSession` call lands.
    await deps.releaseRosterSession(rosterId);
    return ok(undefined);
  }

  // ── Budget-event ingestion ───────────────────────────────────────

  function foldBudgetEvent(
    rosterId: RosterId,
    event: BudgetEvent,
  ): Result<void, RosterTrackError> {
    const rec = rosters.get(rosterId);
    if (!rec) return err({ _tag: "RosterNotFound", rosterId });
    rec.budgetState = applyBudgetEvent(rec.budgetState, event);
    return ok(undefined);
  }

  function recordPeerMessageObserved(
    rosterId: RosterId,
    session: AoSessionName,
    atMs: WallClockMs,
  ): Result<void, RosterTrackError> {
    return foldBudgetEvent(rosterId, {
      _tag: "PeerMessageObserved",
      session,
      atMs,
    });
  }

  function recordTokensConsumed(
    rosterId: RosterId,
    session: AoSessionName,
    tokens: TokenCount,
  ): Result<void, RosterTrackError> {
    return foldBudgetEvent(rosterId, {
      _tag: "TokensConsumed",
      session,
      tokens,
    });
  }

  async function stepBudget(
    rosterId: RosterId,
    nowMs: WallClockMs,
  ): Promise<BudgetStepOutcome> {
    const rec = rosters.get(rosterId);
    if (!rec) {
      return {
        _tag: "StepFailed",
        reason: { _tag: "RosterNotFound", rosterId },
      };
    }
    const verdict = checkBudget(rec.budgetState, nowMs);
    const scope = retireScopeFor(verdict);
    switch (scope._tag) {
      case "None":
        return { _tag: "WithinBudget" };
      case "RetireMember": {
        if (scope.session === null) {
          // Defensive: retireScopeFor always pairs RetireMember with a
          // non-null session, but the type permits null so check.
          return { _tag: "WithinBudget" };
        }
        const reason: RetireReason =
          verdict._tag === "IdleTimeoutTripped"
            ? { _tag: "IdleTimeoutTripped", idleSinceMs: verdict.idleForMs }
            : { _tag: "RosterBudgetTripped", verdict };
        const retireRes = await retireMember(rosterId, scope.session, reason);
        if (retireRes._tag === "Err") {
          return { _tag: "StepFailed", reason: retireRes.error };
        }
        return {
          _tag: "MemberRetired",
          session: scope.session,
          verdict,
        };
      }
      case "RetireRoster": {
        const reason: RetireReason = {
          _tag: "RosterBudgetTripped",
          verdict,
        };
        const retireRes = await retireRoster(rosterId, reason);
        if (retireRes._tag === "Err") {
          return { _tag: "StepFailed", reason: retireRes.error };
        }
        return {
          _tag: "RosterRetired",
          rosterId,
          verdict,
        };
      }
      default:
        // Principle 4: exhaustive over the scope tag union.
        return absurd(scope._tag);
    }
  }

  function listActiveRosterIds(): readonly RosterId[] {
    return [...rosters.keys()];
  }

  function findRosterForSession(session: AoSessionName): RosterId | null {
    for (const [rid, rec] of rosters) {
      if (rec.statuses.has(session)) return rid;
    }
    return null;
  }

  return {
    spawnRoster,
    trackRoster,
    retireMember,
    retireRoster,
    recordPeerMessageObserved,
    recordTokensConsumed,
    stepBudget,
    listActiveRosterIds,
    findRosterForSession,
  };
}

// ── Pure helpers ──────────────────────────────────────────────────

export function resolveRetiredRecipientRoute(
  roster: readonly RosterMemberStatus[],
  orchestratorSenderId: MoltzapSenderId,
): { readonly orchestrator: MoltzapSenderId } {
  // The roster parameter is carried for observability — callers may log
  // which retired recipient triggered the reroute — but the route itself is
  // always "orchestrator" (Invariant 9).
  void roster;
  return { orchestrator: orchestratorSenderId };
}

