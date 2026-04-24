/**
 * moltzap/identity-allowlist — sender-identity gate (I1).
 *
 * Anchors: spec moltzap-channel-v1 §4 I1, §5.1 AC1.2, §5.2 AC2.2; sub-issue
 * zap#133 architect decision (option b).
 *
 * Historical context: before sbd#172, the allowlist lived behind a
 * zapbot-local bridge that consumed a zapbot-local `MoltzapInbound`. After
 * the extraction into `@moltzap/claude-code-channel`, the channel exposes
 * a `gateInbound` hook that takes upstream's `EnrichedInboundMessage`.
 * `buildSenderAllowlistGate` is the adapter zapbot uses to wire this
 * module into the upstream hook shape while keeping the allowlist's
 * storage, role-extension, and test surface local.
 *
 * Non-allowlisted events return `SenderNotAllowed` and are dropped with a
 * diagnostic at the caller. No turn in the Claude session, no transcript
 * side effect (AC1.2).
 */

import type {
  AllowlistError as UpstreamAllowlistError,
  GateInbound as UpstreamGateInbound,
} from "@moltzap/claude-code-channel";
import type { Result } from "../types.ts";
import { err, ok } from "../types.ts";
import type { MoltzapSenderId } from "./types.ts";

// ── Allowlist handle ────────────────────────────────────────────────

export interface SenderAllowlist {
  readonly __brand: "SenderAllowlist";
}

const ALLOWLIST = Symbol("SenderAllowlist.values");
type SenderAllowlistInternal = SenderAllowlist & {
  readonly [ALLOWLIST]: ReadonlySet<string>;
};

/** Construct a frozen allowlist from a configured set of sender IDs. */
export function fromSenderIds(ids: readonly MoltzapSenderId[]): SenderAllowlist {
  return Object.freeze({
    __brand: "SenderAllowlist",
    [ALLOWLIST]: new Set(ids),
  }) as SenderAllowlist;
}

/**
 * Extract the sender-id set from an opaque allowlist. Used by
 * `role-topology.extendAllowlistForRole` to union the base entries with
 * per-role peer additions.
 */
export function toSenderIds(list: SenderAllowlist): readonly MoltzapSenderId[] {
  const internal = list as SenderAllowlistInternal;
  return [...internal[ALLOWLIST]] as unknown as readonly MoltzapSenderId[];
}

// ── Error channel (zapbot-local) ────────────────────────────────────

export type AllowlistError = {
  readonly _tag: "SenderNotAllowed";
  readonly senderId: MoltzapSenderId;
  readonly conversationId: string;
  readonly messageId: string;
};

// ── Gate (zapbot-local shape) ───────────────────────────────────────

/**
 * Check a sender against the configured allowlist.
 * Pure; synchronous; O(1) set membership.
 */
export function checkSender(
  allowlist: SenderAllowlist,
  senderId: MoltzapSenderId,
  context: { readonly conversationId: string; readonly messageId: string },
): Result<void, AllowlistError> {
  const values = (allowlist as SenderAllowlistInternal)[ALLOWLIST];
  if (values.has(senderId)) {
    return ok(undefined);
  }
  return err({
    _tag: "SenderNotAllowed",
    senderId,
    conversationId: context.conversationId,
    messageId: context.messageId,
  });
}

// ── Adapter: wire zapbot allowlist → upstream GateInbound ───────────

/**
 * Build a `GateInbound` hook conforming to `@moltzap/claude-code-channel`'s
 * public surface, backed by a zapbot-local `SenderAllowlist`. Pure,
 * synchronous. On rejection, returns `UpstreamAllowlistError.SenderNotAllowed`
 * with a human-readable `reason` so upstream's logger can diagnose.
 */
export function buildSenderAllowlistGate(
  allowlist: SenderAllowlist,
): UpstreamGateInbound {
  // The `UpstreamGateInbound` signature types `event` as upstream's
  // `EnrichedInboundMessage`, which is nominally distinct from zapbot's
  // own `@moltzap/client` copy's type because of the split
  // published-vs-linked resolution. We deliberately let TypeScript infer
  // the parameter here; the runtime shape (sender.id, conversationId, id)
  // is identical and exercised by the upstream integration test.
  const gate: UpstreamGateInbound = (event) => {
    const values = (allowlist as SenderAllowlistInternal)[ALLOWLIST];
    if (values.has(event.sender.id)) {
      return { _tag: "Success", value: event };
    }
    const error: UpstreamAllowlistError = {
      _tag: "SenderNotAllowed",
      senderId: event.sender.id,
      reason: `sender ${event.sender.id} not on allowlist (conversation=${event.conversationId}, message=${event.id})`,
    };
    return { _tag: "Failure", error };
  };
  return gate;
}
