/**
 * claude-channel/event — shape MoltZap traffic into Claude Code's official
 * channel notification contract.
 *
 * Architect phase only: public surface, no implementation.
 */

import type { Result } from "../types.ts";
import { err, ok } from "../types.ts";
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
  if (event.bodyText.trim().length === 0) {
    return err({ _tag: "ContentEmpty" });
  }
  const metaError = validateInboundMeta(event);
  if (metaError !== null) {
    return err(metaError);
  }
  return ok({
    method: "notifications/claude/channel",
    params: {
      content: event.bodyText,
      meta: {
        conversation_id: event.conversationId,
        sender_id: event.senderId,
        message_id: event.messageId,
        received_at_ms: String(event.receivedAtMs),
      },
    },
  });
}

/**
 * Convert a parsed remote allow/deny verdict into Claude Code's permission
 * relay notification shape.
 */
export function toClaudePermissionNotification(
  verdict: ClaudePermissionVerdict,
): Result<ClaudeChannelPermissionNotification, ClaudeChannelEventShapeError> {
  if (verdict.requestId.trim().length === 0) {
    return err({
      _tag: "PermissionRequestIdInvalid",
      value: verdict.requestId,
    });
  }
  return ok({
    method: "notifications/claude/channel/permission",
    params: {
      request_id: verdict.requestId.trim(),
      behavior: verdict.behavior,
    },
  });
}

function validateInboundMeta(
  event: MoltzapInbound,
): Extract<ClaudeChannelEventShapeError, { readonly _tag: "MetaInvalid" }> | null {
  if (!isNonEmptyBrand(event.conversationId)) {
    return { _tag: "MetaInvalid", reason: "conversation_id must be a non-empty string" };
  }
  if (!isNonEmptyBrand(event.senderId)) {
    return { _tag: "MetaInvalid", reason: "sender_id must be a non-empty string" };
  }
  if (!isNonEmptyBrand(event.messageId)) {
    return { _tag: "MetaInvalid", reason: "message_id must be a non-empty string" };
  }
  if (!Number.isFinite(event.receivedAtMs) || event.receivedAtMs < 0) {
    return { _tag: "MetaInvalid", reason: "received_at_ms must be a non-negative finite number" };
  }
  return null;
}

function isNonEmptyBrand(
  value: MoltzapConversationId | MoltzapSenderId | MoltzapMessageId,
): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
