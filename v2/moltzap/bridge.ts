/**
 * v2/moltzap/bridge — translate moltzap ↔ MCP.
 *
 * Anchors: sbd#108 architect plan §2.3 bridge, §3 Interfaces; spec
 * moltzap-channel-v1 §5.1 AC1.1, AC1.2; §4 invariants I3, I7.
 *
 * Inbound  (moltzap → MCP):   onInbound(event) → mcp.notification (channel tag).
 * Outbound (MCP → moltzap):   reply(args) → SDK send.
 *
 * Both directions gate on `LISTENING`. Non-LISTENING calls return tagged
 * errors; they never throw. Pre-ready events (architect-defined diagnostic
 * `PreReadyEventDropped`) are dropped — no buffer (I7).
 */

import type { Result } from "../types.ts";
import { err, ok } from "../types.ts";
import type { LifecycleState } from "./lifecycle.ts";
import type {
  McpContext,
  MoltzapConversationId,
  MoltzapInbound,
  MoltzapInboundMeta,
  MoltzapSdkContext,
  MoltzapSenderId,
} from "./types.ts";

// ── Errors ──────────────────────────────────────────────────────────

export type BridgeError =
  | { readonly _tag: "NotListening"; readonly state: LifecycleState }
  | { readonly _tag: "OutboundFailed"; readonly cause: unknown }
  | { readonly _tag: "PreReadyEventDropped"; readonly event: MoltzapInboundMeta };

// ── Reply shape ─────────────────────────────────────────────────────

export interface ReplyArgs {
  readonly conversationId: MoltzapConversationId;
  readonly text: string;
}

export interface ReplyReceipt {
  readonly _tag: "Sent";
  readonly at: number;
}

// ── Injection points ────────────────────────────────────────────────
//
// The MCP notify and moltzap send functions are supplied by the plugin boot
// layer, matching the "opaque handle" design in architect plan §3. The
// bridge never imports `@modelcontextprotocol/sdk` or `@moltzap/app-sdk`
// directly; substitution at the boundary keeps the bridge testable without
// either SDK present.

export type McpNotifier = (
  ctx: McpContext,
  notification: ChannelNotification,
) => Promise<Result<void, { readonly cause: unknown }>>;

export type MoltzapSender = (
  ctx: MoltzapSdkContext,
  args: ReplyArgs,
) => Promise<Result<void, { readonly cause: unknown }>>;

/** Shape written to MCP when routing an inbound moltzap event. */
export interface ChannelNotification {
  readonly method: "notifications/claude/channel";
  readonly params: {
    readonly channelTag: string;
    readonly conversationId: MoltzapConversationId;
    readonly senderId: MoltzapSenderId;
    readonly messageId: string;
    readonly body: string;
    readonly receivedAtMs: number;
  };
}

/** Diagnostic sink for `PreReadyEventDropped` — plugin boot injects stderr
 *  logger; tests may inject a recorder. Kept synchronous (diagnostic only). */
export type DiagnosticSink = (error: BridgeError) => void;

// ── Inbound ─────────────────────────────────────────────────────────

export async function onInbound(
  state: LifecycleState,
  event: MoltzapInbound,
  mcp: McpContext,
  notify: McpNotifier,
  diag: DiagnosticSink,
): Promise<Result<void, BridgeError>> {
  if (state._tag !== "LISTENING") {
    // Per architect plan §4: the SDK should not deliver events before
    // ready fires under option (a), but we defend in depth. Diagnose and
    // drop; no buffering (I7).
    const dropped: BridgeError = {
      _tag: "PreReadyEventDropped",
      event: {
        messageId: event.messageId,
        conversationId: event.conversationId,
        senderId: event.senderId,
        receivedAtMs: event.receivedAtMs,
      },
    };
    diag(dropped);
    return err(dropped);
  }
  // Defend against injected notifiers that throw/reject instead of returning
  // `Err` — a closed stdio transport in the real SDK can surface that way.
  // Principle 3: errors are typed, not thrown — re-pack into `OutboundFailed`.
  let result: Result<void, { readonly cause: unknown }>;
  try {
    result = await notify(mcp, {
      method: "notifications/claude/channel",
      params: {
        channelTag: "moltzap",
        conversationId: event.conversationId,
        senderId: event.senderId,
        messageId: event.messageId,
        body: event.bodyText,
        receivedAtMs: event.receivedAtMs,
      },
    });
  } catch (cause) {
    return err({ _tag: "OutboundFailed", cause });
  }
  if (result._tag === "Err") {
    return err({ _tag: "OutboundFailed", cause: result.error.cause });
  }
  return ok(undefined);
}

// ── Outbound ────────────────────────────────────────────────────────

export async function reply(
  state: LifecycleState,
  args: ReplyArgs,
  sdkCtx: MoltzapSdkContext,
  sender: MoltzapSender,
  now: () => number = Date.now,
): Promise<Result<ReplyReceipt, BridgeError>> {
  if (state._tag !== "LISTENING") {
    return err({ _tag: "NotListening", state });
  }
  // Defend against injected senders that throw/reject instead of returning
  // `Err` — a closed websocket in the real SDK can surface that way.
  // Principle 3: errors are typed, not thrown — re-pack into `OutboundFailed`.
  let result: Result<void, { readonly cause: unknown }>;
  try {
    result = await sender(sdkCtx, args);
  } catch (cause) {
    return err({ _tag: "OutboundFailed", cause });
  }
  if (result._tag === "Err") {
    return err({ _tag: "OutboundFailed", cause: result.error.cause });
  }
  return ok({ _tag: "Sent", at: now() });
}
