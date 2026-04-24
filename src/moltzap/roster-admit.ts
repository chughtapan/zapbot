/**
 * moltzap/roster-admit — late-joiner conversation-level admission helper.
 *
 * Anchors: sbd#170 SPEC rev 2, Invariant 11; Non-goal 8; §5 "Roster-growth
 * handling (post-Spike A)" bullet; Spike A verdict (sbd#181): public RPC
 * `apps/admitParticipant` does NOT exist upstream; `conversations/
 * addParticipant` admits conversation-level only.
 *
 * v1 scope (binding): late-joining roster members are admitted to
 * conversations only, not to the `app_session_participants` row. This
 * module encapsulates that one call and the set of conversations a new
 * joiner is added to, derived from `receivableKeysForRole(role)` plus
 * `sendableKeysForRole(role)` for the joiner's role.
 *
 * Non-goal 8 fence: this module does NOT paper over session-level
 * admission. If `apps/admitParticipant` (or equivalent) ships upstream,
 * `admitLateJoiner` gains a session-level branch; until then, the function
 * returns `LateJoinerSessionLevelUnavailable` on request for that path —
 * callers receive a typed no-op receipt, not a silent success.
 */

import { Effect } from "effect";
import type { AppSessionHandle, MoltZapApp } from "@moltzap/app-sdk";
import type { SessionRole } from "./session-role.ts";
import type { ConversationKey } from "./conversation-keys.ts";
import {
  ALL_CONVERSATION_KEYS,
  receivableKeysForRole,
  sendableKeysForRole,
} from "./conversation-keys.ts";
import type {
  MoltzapConversationId,
  MoltzapSenderId,
} from "./types.ts";
import { asMoltzapConversationId } from "./types.ts";

// ── Inputs ──────────────────────────────────────────────────────────

export interface LateJoinerAdmitRequest {
  readonly joinerSenderId: MoltzapSenderId;
  readonly joinerRole: Exclude<SessionRole, "orchestrator">;
  /**
   * The bridge's handle; the bridge is the session initiator and holds
   * `role: "owner"` on every manifest conversation. Only the bridge may
   * invoke `conversations/addParticipant` (Spike A §"conversation-level
   * admission: yes" condition).
   */
  readonly bridgeApp: MoltZapApp;
  readonly session: AppSessionHandle;
  /**
   * Caller asserts this process is the session initiator (the bridge). If
   * false, the call returns `NotInitiator` without issuing any RPC.
   * Default is true so standard bridge-side usage doesn't need to pass it
   * explicitly.
   */
  readonly isInitiator?: boolean;
  /**
   * When set, `admitLateJoiner` returns a `LateJoinerSessionLevelUnavailable`
   * error instead of running the conversation-level admission. Surfaced as a
   * typed no-op receipt for callers that request session-level admission
   * (e.g., a future feature guarded by a flag). v1 callers never set this.
   */
  readonly requireSessionLevel?: boolean;
}

/**
 * The concrete per-role mapping of which conversations a late joiner is
 * added to. Computed as `sendableKeysForRole(role) ∪ receivableKeysForRole(role)`.
 *
 * Enumeration order follows `ALL_CONVERSATION_KEYS` for determinism so
 * telemetry diffs remain stable across runs.
 */
export function conversationsToAdmitForRole(
  role: Exclude<SessionRole, "orchestrator">,
): readonly ConversationKey[] {
  const set = new Set<ConversationKey>([
    ...sendableKeysForRole(role),
    ...receivableKeysForRole(role),
  ]);
  return ALL_CONVERSATION_KEYS.filter((k) => set.has(k));
}

// ── Errors ──────────────────────────────────────────────────────────

export type LateJoinerAdmitError =
  | {
      readonly _tag: "NotInitiator";
      readonly reason: string;
    }
  | {
      readonly _tag: "KeyNotInSession";
      readonly key: ConversationKey;
    }
  | {
      readonly _tag: "AddParticipantRpcFailed";
      readonly key: ConversationKey;
      readonly cause: string;
    }
  | {
      readonly _tag: "LateJoinerSessionLevelUnavailable";
      readonly upstreamIssue: "https://github.com/chughtapan/moltzap/issues/206";
    };

export interface LateJoinerAdmitResult {
  readonly joinerSenderId: MoltzapSenderId;
  readonly joinerRole: Exclude<SessionRole, "orchestrator">;
  readonly admittedTo: readonly {
    readonly key: ConversationKey;
    readonly conversationId: MoltzapConversationId;
  }[];
  /**
   * v1: always `false`. Upstream tracking ticket is moltzap#206. When the
   * upstream RPC ships, this becomes a decision in `admitLateJoiner` and
   * the field reflects whether the session-level admission ran.
   */
  readonly admittedAtSessionLevel: boolean;
}

// ── Public surface ──────────────────────────────────────────────────

/**
 * Admit a late-joining roster member to conversation-level membership.
 * MUST be called from the bridge process (the session initiator). For
 * each key in `conversationsToAdmitForRole(joinerRole)`, invokes
 * `conversations/addParticipant` via `bridgeApp.client.sendRpc`.
 *
 * v1 scope: returns `LateJoinerAdmitResult` with `admittedAtSessionLevel:
 * false` on success. Callers that require session-level admission
 * (on_join hooks, getSession visibility) get a typed receipt of the
 * limitation, not a silent gap.
 */
export function admitLateJoiner(
  request: LateJoinerAdmitRequest,
): Effect.Effect<LateJoinerAdmitResult, LateJoinerAdmitError> {
  if (request.isInitiator === false) {
    return Effect.fail<LateJoinerAdmitError>({
      _tag: "NotInitiator",
      reason:
        "admitLateJoiner must be invoked from the session initiator (bridge) process",
    });
  }
  if (request.requireSessionLevel === true) {
    return Effect.fail<LateJoinerAdmitError>({
      _tag: "LateJoinerSessionLevelUnavailable",
      upstreamIssue:
        "https://github.com/chughtapan/moltzap/issues/206" as const,
    });
  }

  const keys = conversationsToAdmitForRole(request.joinerRole);

  // Pre-validate every key resolves before firing any RPC so a mid-run
  // partial failure doesn't leave half the conversations admitted and
  // the caller blind to which.
  const resolved: { readonly key: ConversationKey; readonly raw: string }[] = [];
  for (const key of keys) {
    const raw = request.session.conversations[key];
    if (typeof raw !== "string" || raw.length === 0) {
      return Effect.fail<LateJoinerAdmitError>({
        _tag: "KeyNotInSession",
        key,
      });
    }
    resolved.push({ key, raw });
  }

  // Chain the RPCs sequentially; each maps its own error to
  // `AddParticipantRpcFailed` with the key tag. Using Effect.reduce keeps
  // the type inference clean (no yield* widening).
  type Admitted = {
    readonly key: ConversationKey;
    readonly conversationId: MoltzapConversationId;
  };
  const initial: readonly Admitted[] = [];
  const chain: Effect.Effect<
    readonly Admitted[],
    LateJoinerAdmitError,
    never
  > = Effect.reduce(resolved, initial, (acc, { key, raw }) =>
    (request.bridgeApp.client
      .sendRpc("conversations/addParticipant", {
        conversationId: raw,
        agentId: request.joinerSenderId as unknown as string,
      }) as Effect.Effect<unknown, unknown, never>)
      .pipe(
        Effect.mapError(
          (e): LateJoinerAdmitError => ({
            _tag: "AddParticipantRpcFailed",
            key,
            cause: e instanceof Error ? e.message : String(e),
          }),
        ),
        Effect.map((): readonly Admitted[] => [
          ...acc,
          { key, conversationId: asMoltzapConversationId(raw) },
        ]),
      ),
  );
  return chain.pipe(
    Effect.map(
      (admittedTo): LateJoinerAdmitResult => ({
        joinerSenderId: request.joinerSenderId,
        joinerRole: request.joinerRole,
        admittedTo: [...admittedTo],
        admittedAtSessionLevel: false,
      }),
    ),
  );
}
