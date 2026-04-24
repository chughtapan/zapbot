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
 *
 * Architect stage — bodies throw.
 */

import type { Effect } from "effect";
import type { AppSessionHandle, MoltZapApp } from "@moltzap/app-sdk";
import type { SessionRole } from "./session-role.ts";
import type { ConversationKey } from "./conversation-keys.ts";
import type {
  MoltzapSenderId,
  MoltzapConversationId,
} from "./types.ts";

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
}

/**
 * Concrete per-role mapping of which conversations a late joiner is added
 * to. Enumerated per conversation key; resolved at call time via
 * `conversation-keys.ts`.
 *
 * Addresses codex round-2 "relevant conversation(s) vagueness" concern:
 * for EACH joiner role, the concrete set of keys admitted is the union of
 * `sendableKeysForRole(role) ∪ receivableKeysForRole(role)`. Implementation
 * computes this union; the set is finite and enumerable at call time.
 *
 * v1 per-role add-to sets (computed, not hard-coded):
 *   architect   → coord-orch-to-worker, coord-worker-to-orch,
 *                 coord-architect-peer, coord-implementer-to-architect,
 *                 coord-review-to-author
 *   implementer → coord-orch-to-worker, coord-worker-to-orch,
 *                 coord-implementer-to-architect, coord-review-to-author
 *   reviewer    → coord-orch-to-worker, coord-worker-to-orch,
 *                 coord-review-to-author
 *
 * Implementation derives these lists from the `conversation-keys.ts`
 * bindings. The per-role union is computed there; this module only owns
 * the wire-up.
 */
export function conversationsToAdmitForRole(
  role: Exclude<SessionRole, "orchestrator">,
): readonly ConversationKey[] {
  throw new Error("not implemented");
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
 * v1 scope: returns `LateJoinerAdmitResult` with
 * `admittedAtSessionLevel: false` on success. Callers that require
 * session-level admission (on_join hooks, getSession visibility) get a
 * typed receipt of the limitation, not a silent gap.
 */
export function admitLateJoiner(
  request: LateJoinerAdmitRequest,
): Effect.Effect<LateJoinerAdmitResult, LateJoinerAdmitError> {
  throw new Error("not implemented");
}
