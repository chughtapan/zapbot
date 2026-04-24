/**
 * moltzap/mcp-adapter — app-sdk → MCP notification forwarder.
 *
 * Anchors: sbd#170 SPEC rev 2, §5 "thin adapter forwards `app.onMessage`
 * payloads to MCP notifications"; research verdict §(b) item 4 ("MCP-as-
 * Claude-transport stays; simplify; do not remove"); deletion list
 * `src/moltzap/bridge.ts` + `src/moltzap/channel-runtime.ts` collapse into
 * this adapter.
 *
 * This module owns one boundary: mapping a `@moltzap/app-sdk` `Message`
 * (received via `onMessageForKey`) to a typed `ClaudeChannelNotification`
 * and emitting it through the booted `ClaudeChannelServerHandle`. No
 * protocol translation outside that seam.
 */

import type { Message, Part } from "@moltzap/app-sdk";
import type {
  ClaudeChannelNotification,
} from "../claude-channel/event.ts";
import type { ClaudeChannelServerHandle } from "../claude-channel/server.ts";
import type { ConversationKey } from "./conversation-keys.ts";
import type { MoltzapSenderId } from "./types.ts";
import {
  asMoltzapConversationId,
  asMoltzapMessageId,
  asMoltzapSenderId,
} from "./types.ts";

// ── Inputs ──────────────────────────────────────────────────────────

export interface McpAdapterContext {
  readonly channel: ClaudeChannelServerHandle;
  /**
   * Identity the local process advertises to Claude notifications.
   * Carried through from `AppBootConfig` (orchestrator or worker sender).
   */
  readonly localSenderId: MoltzapSenderId;
  /**
   * For worker roles, the bridge's senderId — stamped on inbound
   * notifications so Claude can reply via MCP `reply` tool. Null for the
   * bridge itself.
   */
  readonly orchestratorSenderId: MoltzapSenderId | null;
}

// ── Errors ──────────────────────────────────────────────────────────

export type McpAdapterError =
  | {
      readonly _tag: "UnknownMessageShape";
      readonly reason: string;
      readonly messageId: string;
    }
  | {
      readonly _tag: "McpNotifyFailed";
      readonly cause: string;
    };

// ── Public surface ──────────────────────────────────────────────────

function flattenParts(parts: readonly Part[]): string {
  const chunks: string[] = [];
  for (const part of parts) {
    switch (part.type) {
      case "text":
        chunks.push(part.text);
        break;
      case "image":
        chunks.push(`[image] ${part.url}${part.altText ? ` — ${part.altText}` : ""}`);
        break;
      case "file":
        chunks.push(`[file] ${part.name} (${part.url})`);
        break;
      default: {
        // Part is a typebox union of {text,image,file}; this branch is
        // reached only if the upstream schema gains a new variant.
        const pAny = part as { readonly type?: unknown };
        chunks.push(`[unknown part: ${String(pAny.type)}]`);
        break;
      }
    }
  }
  return chunks.join("\n");
}

/**
 * Convert one `Message` on `key` into a `ClaudeChannelNotification`. Pure;
 * no I/O. Principle 3 tie: returns an error union, never throws.
 *
 * `key` is the typed conversation key delivered by `app.onMessage(key, ...)`.
 * Invariant 6: the key carries the role-pair; we do not inspect the sender
 * for role gating — we just stamp the fields through.
 */
export function toClaudeNotification(
  key: ConversationKey,
  message: Message,
  ctx: McpAdapterContext,
): ClaudeChannelNotification | McpAdapterError {
  void ctx;
  void key; // preserved for future per-key formatting; spec Invariant 6 keeps it inert
  if (
    !message ||
    typeof message.id !== "string" ||
    typeof message.conversationId !== "string" ||
    typeof message.senderId !== "string" ||
    !Array.isArray(message.parts) ||
    message.parts.length === 0
  ) {
    return {
      _tag: "UnknownMessageShape",
      reason: "message missing required id/conversationId/senderId/parts",
      messageId: String(message?.id ?? "<missing>"),
    };
  }
  const content = flattenParts(message.parts as readonly Part[]);
  if (content.trim().length === 0) {
    return {
      _tag: "UnknownMessageShape",
      reason: "message parts contained no non-empty text",
      messageId: message.id,
    };
  }
  const receivedAtMs = Date.now();
  return {
    method: "notifications/claude/channel",
    params: {
      content,
      meta: {
        conversation_id: asMoltzapConversationId(message.conversationId),
        sender_id: asMoltzapSenderId(message.senderId),
        message_id: asMoltzapMessageId(message.id),
        received_at_ms: String(receivedAtMs),
      },
    },
  };
}

/**
 * Forwarder registered as the `app.onMessage(key, handler)` for each
 * key in `receivableKeysForRole(role)`. Wraps `toClaudeNotification` and
 * dispatches via `ctx.channel.push(notification)`.
 */
export function makeMcpForwardHandler(
  key: ConversationKey,
  ctx: McpAdapterContext,
): (message: Message) => Promise<void> {
  return async (message) => {
    const result = toClaudeNotification(key, message, ctx);
    if ("_tag" in result) {
      // Typed error; record and drop. No rethrow — the app-sdk handler
      // surface is void and exceptions leak into the SDK's background
      // fiber. Logging to stderr is the one external effect here.
      const err = result;
      // eslint-disable-next-line no-console
      console.warn(
        `[mcp-adapter] key=${key} dropped message ${err._tag}: ${
          err._tag === "UnknownMessageShape" ? err.reason : err.cause
        }`,
      );
      return;
    }
    const push = await ctx.channel.push(result);
    if (push._tag === "Err") {
      // eslint-disable-next-line no-console
      console.warn(
        `[mcp-adapter] key=${key} push failed: ${push.error.cause}`,
      );
    }
  };
}

/**
 * Return the list of keys for which a forwarder should be installed. The
 * actual `app.onMessage` registration is performed by the boot code that
 * owns the `MoltZapApp` handle (see `app-client.ts`); this helper exists so
 * callers can iterate a single list and keep the registration loop in one
 * place.
 */
export function wireMcpAdapter(
  ctx: McpAdapterContext,
  receivableKeys: readonly ConversationKey[],
): readonly ConversationKey[] {
  void ctx;
  return [...receivableKeys];
}
