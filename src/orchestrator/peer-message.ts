/**
 * orchestrator/peer-message — typed peer-channel message shape + decode.
 *
 * Anchors: SPEC r4.1 (https://github.com/chughtapan/safer-by-default/issues/145#issuecomment-4307793815)
 *   Goal 4 (safer-side peer-message primitive), Goal 5 (raw-comment
 *   interpretation); Acceptance (d), (e); Invariants 5, 7, 9.
 *
 * Responsibility: give every raw MoltZap peer-channel event a typed shape
 * the orchestrator prompt can route on deterministically. A worker comment
 * that does not decode is an escalation, NOT a silent drop (Acceptance (e)
 * bullet 2).
 *
 * Invariant 7 enforcement at the type level: `PeerMessageKind` contains no
 * `"vote-tally"`, no `"winner-declaration"`, no `"elimination-signal"`.
 * Convergence selection is orchestrator-only, in prose, not on the wire.
 *
 * This module is the code-side of the primitive. The safer-side CLI wrapper
 * `safer-by-default/bin/safer-peer-message` calls `encodePeerMessage`
 * indirectly via the MoltZap bridge. SKILL.md prompt files never import
 * MoltZap directly (Acceptance (d) bullet 1).
 *
 * Architect phase only: public surface, no implementation.
 */

import type { AoSessionName, Result } from "../types.ts";
import type { PeerChannelKind } from "../moltzap/role-topology.ts";
import type { SessionRole } from "../moltzap/session-client.ts";
import type { MoltzapSenderId } from "../moltzap/types.ts";

// ── Kinds ───────────────────────────────────────────────────────────
//
// Closed union. Any wire message whose `kind` is outside this set is an
// escalation (`PeerMessageKindUnknown`).

export type PeerMessageKind =
  | "artifact-published"
  | "status-update"
  | "review-request"
  | "architect-peer-ping"
  | "retire-notice";

// ── Addressing ──────────────────────────────────────────────────────

export interface PeerEndpoint {
  readonly role: SessionRole;
  readonly session: AoSessionName;
  readonly senderId: MoltzapSenderId;
}

/**
 * Recipient addressing. `senderId` may be null when the caller addresses by
 * role (e.g. "any reviewer"); the roster resolves role-only addresses to a
 * concrete `senderId` at send time.
 */
export interface PeerRecipient {
  readonly role: SessionRole;
  readonly senderId: MoltzapSenderId | null;
}

// ── Message shape ───────────────────────────────────────────────────

export interface PeerMessage {
  readonly _tag: "PeerMessage";
  readonly kind: PeerMessageKind;
  readonly channel: PeerChannelKind;
  readonly from: PeerEndpoint;
  readonly to: PeerRecipient;
  readonly body: string;
  /** Link to the durable GitHub artifact, when applicable. Acceptance (d)
   *  bullet 4: the primitive does not persist; peer messages reference
   *  durable state, they do not create it. */
  readonly artifactUrl: string | null;
  readonly correlationId: string;
  readonly sentAtMs: number;
}

// ── Errors ──────────────────────────────────────────────────────────

export type PeerMessageDecodeError =
  | { readonly _tag: "PeerMessageShapeInvalid"; readonly reason: string }
  | { readonly _tag: "PeerMessageKindUnknown"; readonly raw: string }
  | { readonly _tag: "PeerMessageChannelUnknown"; readonly raw: string };

export type PeerMessageSendError =
  | {
      readonly _tag: "RecipientRetired";
      readonly rerouteTo: { readonly orchestrator: MoltzapSenderId };
    }
  | { readonly _tag: "ChannelDisallowed"; readonly reason: string }
  | { readonly _tag: "TransportFailed"; readonly cause: string }
  | { readonly _tag: "EncodeFailed"; readonly cause: string };

export type PeerMessageReceipt =
  | { readonly _tag: "Delivered"; readonly atMs: number }
  | {
      readonly _tag: "ReroutedToOrchestrator";
      readonly atMs: number;
      readonly orchestrator: MoltzapSenderId;
    };

// ── Public surface ──────────────────────────────────────────────────

/**
 * Schema-decode a raw MoltZap inbound body-text into a typed `PeerMessage`.
 * Principle 2: this is the boundary where wire bytes become a trusted type.
 *
 * A decode failure returned by this function is the escalation signal
 * referenced by Acceptance (e) bullet 2. The orchestrator prompt must treat
 * `Err` as an `ESCALATED` state, not a silent drop.
 */
export function decodePeerMessage(
  raw: string,
): Result<PeerMessage, PeerMessageDecodeError> {
  throw new Error("not implemented");
}

/**
 * Encode a `PeerMessage` into the wire body text. Round-trips with
 * `decodePeerMessage`; a property test in `test/orchestrator-peer-message.property.test.ts`
 * gates the round-trip (Principle 1, Corollary §77.1 — algebraic property).
 */
export function encodePeerMessage(msg: PeerMessage): string {
  throw new Error("not implemented");
}

/**
 * Interpret a raw MoltZap inbound comment-body that originated from a
 * worker session. Thin wrapper over `decodePeerMessage` with orchestrator-
 * specific framing: decode errors are rewrapped into the orchestrator's
 * escalation tag (see control-event.ts), which attaches the source session
 * and messageId for the escalation artifact.
 */
export function interpretWorkerComment(
  raw: string,
  source: PeerEndpoint,
): Result<PeerMessage, PeerMessageDecodeError> {
  throw new Error("not implemented");
}

/**
 * Classify a peer message's intended effect on the orchestrator's roster
 * state machine. The orchestrator prompt routes on this classification;
 * worker sessions never see it.
 */
export type PeerMessageRouteAction =
  | { readonly _tag: "ConvergenceCandidate"; readonly artifactUrl: string }
  | { readonly _tag: "StatusIngested" }
  | { readonly _tag: "FollowUpDispatch"; readonly target: PeerRecipient }
  | { readonly _tag: "PeerCoordination" }
  | { readonly _tag: "RetireNotice"; readonly session: AoSessionName };

export function classifyForOrchestrator(
  msg: PeerMessage,
): PeerMessageRouteAction {
  throw new Error("not implemented");
}
