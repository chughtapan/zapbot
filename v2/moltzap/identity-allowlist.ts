/**
 * v2/moltzap/identity-allowlist — sender-identity gate (I1).
 *
 * Anchors: spec moltzap-channel-v1 §4 I1, §5.1 AC1.2, §5.2 AC2.2; sub-issue
 * zap#133 architect decision (option b).
 *
 * The bridge's LISTENING gate (v2/moltzap/bridge.onInbound) closes I3
 * (presence). It does NOT close I1 (sender-authenticated inbound). Spec I1
 * names an ungated path as a prompt-injection vector; AC1.2 requires a
 * sender-identity allowlist check. This module is that gate, separate from
 * the lifecycle gate by design — two invariants, two gates.
 *
 * Composition: plugin boot calls `gateInbound` before `bridge.onInbound`.
 * Non-allowlisted events return `SenderNotAllowed` and are dropped with a
 * diagnostic at the caller. No turn in the Claude session, no transcript
 * side effect (AC1.2).
 */

import type { Result } from "../types.ts";
import { err, ok } from "../types.ts";
import type {
  MoltzapInbound,
  MoltzapInboundMeta,
  MoltzapSenderId,
} from "./types.ts";

// ── Allowlist handle ────────────────────────────────────────────────
//
// Opaque branded type. Constructed once at plugin boot from a configured set
// of sender IDs (config source is impl-junior's choice — env, JSON, etc. —
// per OQ1). Frozen for the lifetime of the plugin process; reload requires
// restart (OQ3). The caller never mutates or inspects the underlying set;
// only `fromSenderIds` constructs and `gateInbound` checks.

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

// ── Error channel ───────────────────────────────────────────────────

export type AllowlistError = {
  readonly _tag: "SenderNotAllowed";
  readonly senderId: MoltzapSenderId;
  readonly event: MoltzapInboundMeta;
};

// ── Gate ────────────────────────────────────────────────────────────

/**
 * Check an inbound event against the configured allowlist.
 *
 * Ok(event)            — sender is on the allowlist; caller forwards to
 *                         `bridge.onInbound`.
 * Err(SenderNotAllowed) — sender is NOT on the allowlist; caller drops
 *                         (logs a diagnostic, does not forward to bridge).
 *
 * Pure; synchronous; O(1) set membership. No side effects.
 */
export function gateInbound(
  allowlist: SenderAllowlist,
  event: MoltzapInbound,
): Result<MoltzapInbound, AllowlistError> {
  const values = (allowlist as SenderAllowlistInternal)[ALLOWLIST];
  if (values.has(event.senderId)) {
    return ok(event);
  }
  return err({
    _tag: "SenderNotAllowed",
    senderId: event.senderId,
    event: {
      messageId: event.messageId,
      conversationId: event.conversationId,
      senderId: event.senderId,
      receivedAtMs: event.receivedAtMs,
    },
  });
}
