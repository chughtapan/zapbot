/**
 * v2/moltzap/types — shared types for the moltzap Channels bridge.
 *
 * Anchors: sbd#108 architect plan §3 Interfaces; spec moltzap-channel-v1 §4 (I6, I7).
 *
 * Conventions mirror v2/types.ts: branded IDs, discriminated unions, tagged
 * errors, `absurd` helper for exhaustiveness. Plain Promise + Result is used
 * throughout per the architect plan's note: "If the repo's existing convention
 * is plain Promise + tagged union, impl may substitute."
 */

// ── Branded identifiers ─────────────────────────────────────────────

export type MoltzapMessageId = string & { readonly __brand: "MoltzapMessageId" };
export type MoltzapConversationId = string & { readonly __brand: "MoltzapConversationId" };
export type MoltzapSenderId = string & { readonly __brand: "MoltzapSenderId" };
export type ListenerHandle = { readonly __brand: "ListenerHandle" };

export function asMoltzapMessageId(s: string): MoltzapMessageId {
  return s as MoltzapMessageId;
}
export function asMoltzapConversationId(s: string): MoltzapConversationId {
  return s as MoltzapConversationId;
}
export function asMoltzapSenderId(s: string): MoltzapSenderId {
  return s as MoltzapSenderId;
}

// ── Inbound event shape ─────────────────────────────────────────────

export interface MoltzapInbound {
  readonly messageId: MoltzapMessageId;
  readonly conversationId: MoltzapConversationId;
  readonly senderId: MoltzapSenderId;
  readonly bodyText: string;
  readonly receivedAtMs: number;
}

export type MoltzapInboundMeta = Pick<
  MoltzapInbound,
  "messageId" | "conversationId" | "senderId" | "receivedAtMs"
>;

// ── Opaque SDK / MCP handles ────────────────────────────────────────
//
// Per architect plan §3: "Opaque to this plugin. Impl picks the exact SDK
// type at impl time." The concrete shape is injected at the plugin boot
// boundary; the bridge modules never import `@moltzap/app-sdk` or
// `@modelcontextprotocol/sdk` directly.

export interface MoltzapSdkHandle {
  readonly __brand: "MoltzapSdkHandle";
}

export interface McpContext {
  readonly __brand: "McpContext";
}

export interface MoltzapSdkContext {
  readonly __brand: "MoltzapSdkContext";
}

// ── Exhaustiveness helper (mirrors v2/types.ts) ─────────────────────

export function absurd(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
