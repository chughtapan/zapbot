/**
 * v2/claude-channel/event — shape MoltZap traffic into Claude Code's official
 * channel notification contract.
 *
 * Architect phase only: public surface, no implementation.
 */

import type { Result } from "../types.ts";
import type {
  MoltzapConversationId,
  MoltzapInbound,
  MoltzapMessageId,
  MoltzapSenderId,
} from "../moltzap/types.ts";

export interface ClaudeChannelNotification {
  readonly method: "notifications/claude/channel";
  readonly params: {
    readonly content: string;
    readonly meta: {
      readonly conversation_id: MoltzapConversationId;
      readonly sender_id: MoltzapSenderId;
      readonly message_id: MoltzapMessageId;
      readonly received_at_ms: string;
    };
  };
}

export interface ClaudePermissionVerdict {
  readonly requestId: string;
  readonly behavior: "allow" | "deny";
}

export interface ClaudeChannelPermissionNotification {
  readonly method: "notifications/claude/channel/permission";
  readonly params: {
    readonly request_id: string;
    readonly behavior: ClaudePermissionVerdict["behavior"];
  };
}

export type ClaudeChannelEventShapeError =
  | { readonly _tag: "ContentEmpty" }
  | { readonly _tag: "MetaInvalid"; readonly reason: string }
  | { readonly _tag: "PermissionRequestIdInvalid"; readonly value: string };

/**
 * Convert a decoded MoltZap inbound message into the notification shape Claude
 * Code expects for a custom channel server.
 */
export function toClaudeChannelNotification(
  event: MoltzapInbound,
): Result<ClaudeChannelNotification, ClaudeChannelEventShapeError> {
  throw new Error("not implemented");
}

/**
 * Convert a parsed remote allow/deny verdict into Claude Code's permission
 * relay notification shape.
 */
export function toClaudePermissionNotification(
  verdict: ClaudePermissionVerdict,
): Result<ClaudeChannelPermissionNotification, ClaudeChannelEventShapeError> {
  throw new Error("not implemented");
}
