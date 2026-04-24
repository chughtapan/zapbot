/**
 * moltzap/mcp-adapter — app-sdk → MCP notification forwarder.
 *
 * Anchors: sbd#170 SPEC rev 2, §5 "thin adapter forwards `app.onMessage`
 * payloads to MCP notifications"; research verdict §(b) item 4 ("MCP-as-
 * Claude-transport stays; simplify; do not remove"); deletion list
 * `src/moltzap/bridge.ts` + `src/moltzap/channel-runtime.ts` collapse into
 * this adapter.
 *
 * This module owns exactly one boundary: mapping a `@moltzap/app-sdk`
 * `Message` (received via `onMessageForKey`) to a typed
 * `ClaudeChannelNotification` and emitting it through the booted
 * `ClaudeChannelServerHandle`. No protocol translation outside that seam.
 *
 * Design intent vs deleted `bridge.ts`: the deleted module carried a
 * `BridgeRuntime` + dispatch table + listener lifecycle; the app-sdk now
 * owns lifecycle, dispatch, and reconnect, so this adapter is a function
 * that knows ONE thing: how to turn `Message` into `ClaudeChannelNotification`.
 *
 * Size budget: <=60 LOC implemented body. If impl exceeds this, re-read the
 * "collapse into the adapter above" line in the deletion table.
 *
 * Architect stage — bodies throw.
 */

import type { Message } from "@moltzap/app-sdk";
import type {
  ClaudeChannelNotification,
} from "../claude-channel/event.ts";
import type { ClaudeChannelServerHandle } from "../claude-channel/server.ts";
import type { ConversationKey } from "./conversation-keys.ts";
import type { MoltzapConversationId, MoltzapSenderId } from "./types.ts";

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

/**
 * Convert one `Message` on `key` into a `ClaudeChannelNotification`. Pure;
 * no I/O. Principle 3 tie: returns an error union, never throws.
 */
export function toClaudeNotification(
  key: ConversationKey,
  message: Message,
  ctx: McpAdapterContext,
): ClaudeChannelNotification | McpAdapterError {
  throw new Error("not implemented");
}

/**
 * Forwarder registered as the `app.onMessage(key, handler)` for EVERY key
 * in `receivableKeysForRole(role)`. Wraps `toClaudeNotification` and
 * dispatches via `ctx.channel.emit(notification)` (or equivalent on the
 * existing `ClaudeChannelServerHandle` surface).
 *
 * This is the single bridge zapbot holds between the app-sdk receive path
 * and the MCP transport; it is the zapbot equivalent of the deleted
 * `bridge.ts` + `channel-runtime.ts`.
 */
export function makeMcpForwardHandler(
  key: ConversationKey,
  ctx: McpAdapterContext,
): (message: Message) => Promise<void> {
  throw new Error("not implemented");
}

/**
 * Install one forwarder per receivable key at boot. Called once by the bin
 * entrypoint (`bin/moltzap-claude-channel.ts`) after `bootApp` resolves.
 * Returns the list of keys that were wired up — used for boot-log output
 * and as the gate for "did we register everything we should?".
 */
export function wireMcpAdapter(
  ctx: McpAdapterContext,
  receivableKeys: readonly ConversationKey[],
): readonly ConversationKey[] {
  throw new Error("not implemented");
}
