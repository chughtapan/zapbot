/**
 * orchestrator/peer-message — typed peer-channel message shape + decode.
 *
 * Anchors: SPEC r4.1 (https://github.com/chughtapan/safer-by-default/issues/145#issuecomment-4307793815)
 *   Goal 4 (safer-side peer-message primitive), Goal 5 (raw-comment
 *   interpretation); Acceptance (d), (e); Invariants 5, 7, 9.
 *
 * Invariant 7 enforcement at the type level: `PeerMessageKind` contains no
 * `"vote-tally"`, no `"winner-declaration"`, no `"elimination-signal"`.
 * Convergence selection is orchestrator-only, in prose, not on the wire.
 *
 * OQ2 resolution: wire format is JSON — one object per MoltZap body text,
 * schema-decoded by `decodePeerMessage`. Kept human-readable in GitHub
 * comments while remaining strictly decodable.
 */

import type { AoSessionName, Result } from "../types.ts";
import { absurd, asAoSessionName, err, ok } from "../types.ts";
import {
  ALL_PEER_CHANNEL_KINDS,
  decodeChannelKind,
  type PeerChannelKind,
} from "../moltzap/role-topology.ts";
import { decodeSessionRole, type SessionRole } from "../moltzap/session-role.ts";
import { asMoltzapSenderId, type MoltzapSenderId } from "../moltzap/types.ts";

// ── Kinds ───────────────────────────────────────────────────────────

export type PeerMessageKind =
  | "artifact-published"
  | "status-update"
  | "review-request"
  | "architect-peer-ping"
  | "retire-notice";

export const ALL_PEER_MESSAGE_KINDS: readonly PeerMessageKind[] = [
  "artifact-published",
  "status-update",
  "review-request",
  "architect-peer-ping",
  "retire-notice",
];

const PEER_MESSAGE_KIND_SET: ReadonlySet<string> = new Set<string>(
  ALL_PEER_MESSAGE_KINDS as readonly string[],
);

// ── Addressing ──────────────────────────────────────────────────────

export interface PeerEndpoint {
  readonly role: SessionRole;
  readonly session: AoSessionName;
  readonly senderId: MoltzapSenderId;
}

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

// ── Decode helpers ──────────────────────────────────────────────────

function shapeInvalid<T>(reason: string): Result<T, PeerMessageDecodeError> {
  return err({ _tag: "PeerMessageShapeInvalid", reason });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function requireString(
  obj: Record<string, unknown>,
  field: string,
): Result<string, PeerMessageDecodeError> {
  const value = obj[field];
  if (typeof value !== "string") {
    return err({
      _tag: "PeerMessageShapeInvalid",
      reason: `field \`${field}\` must be a string`,
    });
  }
  return ok(value);
}

function optionalStringOrNull(
  obj: Record<string, unknown>,
  field: string,
): Result<string | null, PeerMessageDecodeError> {
  const value = obj[field];
  if (value === null || value === undefined) return ok(null);
  if (typeof value !== "string") {
    return err({
      _tag: "PeerMessageShapeInvalid",
      reason: `field \`${field}\` must be a string or null`,
    });
  }
  return ok(value);
}

function requireFiniteNumber(
  obj: Record<string, unknown>,
  field: string,
): Result<number, PeerMessageDecodeError> {
  const value = obj[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return err({
      _tag: "PeerMessageShapeInvalid",
      reason: `field \`${field}\` must be a finite number`,
    });
  }
  return ok(value);
}

function decodeEndpoint(
  raw: unknown,
  field: "from",
): Result<PeerEndpoint, PeerMessageDecodeError> {
  if (!isPlainObject(raw)) {
    return err({
      _tag: "PeerMessageShapeInvalid",
      reason: `field \`${field}\` must be an object`,
    });
  }
  const roleStr = requireString(raw, "role");
  if (roleStr._tag === "Err") return err(roleStr.error);
  const role = decodeSessionRole(roleStr.value);
  if (role._tag === "Err") {
    return err({
      _tag: "PeerMessageShapeInvalid",
      reason: `field \`${field}.role\` has unknown role: ${role.error.raw}`,
    });
  }
  const session = requireString(raw, "session");
  if (session._tag === "Err") return err(session.error);
  const senderId = requireString(raw, "senderId");
  if (senderId._tag === "Err") return err(senderId.error);
  if (session.value.length === 0) {
    return shapeInvalid(`field \`${field}.session\` must be non-empty`);
  }
  if (senderId.value.length === 0) {
    return shapeInvalid(`field \`${field}.senderId\` must be non-empty`);
  }
  return ok({
    role: role.value,
    session: asAoSessionName(session.value),
    senderId: asMoltzapSenderId(senderId.value),
  });
}

function decodeRecipient(
  raw: unknown,
  field: "to",
): Result<PeerRecipient, PeerMessageDecodeError> {
  if (!isPlainObject(raw)) {
    return err({
      _tag: "PeerMessageShapeInvalid",
      reason: `field \`${field}\` must be an object`,
    });
  }
  const roleStr = requireString(raw, "role");
  if (roleStr._tag === "Err") return err(roleStr.error);
  const role = decodeSessionRole(roleStr.value);
  if (role._tag === "Err") {
    return err({
      _tag: "PeerMessageShapeInvalid",
      reason: `field \`${field}.role\` has unknown role: ${role.error.raw}`,
    });
  }
  const rawSender = raw.senderId;
  let senderId: MoltzapSenderId | null;
  if (rawSender === null || rawSender === undefined) {
    senderId = null;
  } else if (typeof rawSender === "string") {
    if (rawSender.length === 0) {
      return shapeInvalid(`field \`${field}.senderId\` must be non-empty or null`);
    }
    senderId = asMoltzapSenderId(rawSender);
  } else {
    return shapeInvalid(`field \`${field}.senderId\` must be string or null`);
  }
  return ok({ role: role.value, senderId });
}

// ── Public surface ──────────────────────────────────────────────────

export function decodePeerMessage(
  raw: string,
): Result<PeerMessage, PeerMessageDecodeError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: unknown) {
    return err({
      _tag: "PeerMessageShapeInvalid",
      reason: `invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  if (!isPlainObject(parsed)) {
    return shapeInvalid("peer message must be a JSON object");
  }

  const tag = parsed._tag;
  if (tag !== "PeerMessage") {
    return shapeInvalid(`field \`_tag\` must be "PeerMessage"`);
  }

  const kindStr = requireString(parsed, "kind");
  if (kindStr._tag === "Err") return err(kindStr.error);
  if (!PEER_MESSAGE_KIND_SET.has(kindStr.value)) {
    return err({ _tag: "PeerMessageKindUnknown", raw: kindStr.value });
  }
  const kind = kindStr.value as PeerMessageKind;

  const channelStr = requireString(parsed, "channel");
  if (channelStr._tag === "Err") return err(channelStr.error);
  const channel = decodeChannelKind(channelStr.value);
  if (channel._tag === "Err") {
    return err({ _tag: "PeerMessageChannelUnknown", raw: channelStr.value });
  }

  const from = decodeEndpoint(parsed.from, "from");
  if (from._tag === "Err") return err(from.error);
  const to = decodeRecipient(parsed.to, "to");
  if (to._tag === "Err") return err(to.error);

  const body = requireString(parsed, "body");
  if (body._tag === "Err") return err(body.error);

  const artifactUrl = optionalStringOrNull(parsed, "artifactUrl");
  if (artifactUrl._tag === "Err") return err(artifactUrl.error);

  const correlationId = requireString(parsed, "correlationId");
  if (correlationId._tag === "Err") return err(correlationId.error);
  if (correlationId.value.length === 0) {
    return shapeInvalid("field `correlationId` must be non-empty");
  }

  const sentAtMs = requireFiniteNumber(parsed, "sentAtMs");
  if (sentAtMs._tag === "Err") return err(sentAtMs.error);

  return ok({
    _tag: "PeerMessage",
    kind,
    channel: channel.value,
    from: from.value,
    to: to.value,
    body: body.value,
    artifactUrl: artifactUrl.value,
    correlationId: correlationId.value,
    sentAtMs: sentAtMs.value,
  });
}

export function encodePeerMessage(msg: PeerMessage): string {
  // Serialize in a stable, round-trippable shape. JSON.stringify order is
  // deterministic for literal object keys; we write the keys explicitly so
  // property tests can assert the key-set.
  const payload = {
    _tag: msg._tag,
    kind: msg.kind,
    channel: msg.channel,
    from: {
      role: msg.from.role,
      session: msg.from.session as string,
      senderId: msg.from.senderId as string,
    },
    to: {
      role: msg.to.role,
      senderId: msg.to.senderId === null ? null : (msg.to.senderId as string),
    },
    body: msg.body,
    artifactUrl: msg.artifactUrl,
    correlationId: msg.correlationId,
    sentAtMs: msg.sentAtMs,
  };
  return JSON.stringify(payload);
}

export function interpretWorkerComment(
  raw: string,
  source: PeerEndpoint,
): Result<PeerMessage, PeerMessageDecodeError> {
  const decoded = decodePeerMessage(raw);
  if (decoded._tag === "Err") return decoded;
  const msg = decoded.value;
  // Guard: the decoded message must declare `source` as its origin (the
  // orchestrator otherwise cannot trust an attacker-supplied `from` field).
  if (msg.from.senderId !== source.senderId) {
    return shapeInvalid(
      `from.senderId does not match inbound source (declared ${msg.from.senderId as string}, source ${source.senderId as string})`,
    );
  }
  if (msg.from.session !== source.session) {
    return shapeInvalid(
      `from.session does not match inbound source (declared ${msg.from.session as string}, source ${source.session as string})`,
    );
  }
  if (msg.from.role !== source.role) {
    return shapeInvalid(
      `from.role does not match inbound source (declared ${msg.from.role}, source ${source.role})`,
    );
  }
  return ok(msg);
}

// ── Routing ─────────────────────────────────────────────────────────

export type PeerMessageRouteAction =
  | { readonly _tag: "ConvergenceCandidate"; readonly artifactUrl: string }
  | { readonly _tag: "StatusIngested" }
  | { readonly _tag: "FollowUpDispatch"; readonly target: PeerRecipient }
  | { readonly _tag: "PeerCoordination" }
  | { readonly _tag: "RetireNotice"; readonly session: AoSessionName };

export function classifyForOrchestrator(
  msg: PeerMessage,
): PeerMessageRouteAction {
  switch (msg.kind) {
    case "artifact-published":
      if (msg.artifactUrl !== null && msg.artifactUrl.length > 0) {
        return { _tag: "ConvergenceCandidate", artifactUrl: msg.artifactUrl };
      }
      // Missing artifact URL on artifact-published is degenerate; treat as
      // a status update rather than silently dropping. Validator paths
      // separately produce PeerMessageShapeInvalid if the schema is tightened.
      return { _tag: "StatusIngested" };
    case "status-update":
      return { _tag: "StatusIngested" };
    case "review-request":
      return { _tag: "FollowUpDispatch", target: msg.to };
    case "architect-peer-ping":
      return { _tag: "PeerCoordination" };
    case "retire-notice":
      return { _tag: "RetireNotice", session: msg.from.session };
    default:
      return absurd(msg.kind);
  }
}

export { ALL_PEER_CHANNEL_KINDS };
