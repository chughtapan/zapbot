/**
 * moltzap/bridge-silence — type-level encoding of the bridge silence
 * invariant.
 *
 * Anchors: sbd#199 acceptance item 7 (bridge silent at app layer per
 * A+C(2) operator decision).
 *
 * The bridge is a participant on every manifest conversation (upstream
 * forces `apps/create` callers to be participants — sbd#197 Round 1).
 * The silence invariant is therefore not server-enforceable from
 * zapbot's side; it is a code-level rule the architecture encodes via
 * TYPE separation:
 *
 *   - `BridgeAppHandle` (in `bridge-app.ts`) has NO `send`, `sendOnKey`,
 *     `sendTo`, or `reply` exports. The handle's only outbound surface
 *     is `createBridgeSession` + `closeBridgeSession`, both of which
 *     are session-lifecycle operations, not app-layer messaging.
 *   - Worker processes do NOT share a handle type with the bridge:
 *     they connect via `@moltzap/claude-code-channel` and hold a
 *     `ChannelHandle` (see `worker-channel.ts`). The channel-plugin's
 *     outbound is the MCP `reply` tool, which is internal to the
 *     channel package and unreachable from bridge code.
 *
 * This module brands `BridgeAppHandle` with `__tag: "bridge"` so any
 * bridge-side helper that legitimately accepts a "tagged handle"
 * (e.g., observability that consumes `onBridgeMessage`) can switch on
 * `__tag` and end the switch with `absurd(handle.__tag)` (Principle 4).
 *
 * **What this module does NOT do.** Detect runtime sends from the
 * bridge. That detection lives in the integration test
 * `test/moltzap-bridge-silence.test.ts`, which asserts no
 * `messages/send` RPC is ever issued from the bridge process during a
 * full session lifecycle.
 *
 * **Revision rationale (rev 2).** Earlier draft united bridge and
 * worker handles in an `AnyAppHandle` discriminator. Under the
 * corrected design (workers = channel-plugin peers, not MoltZapApp
 * consumers), worker code lives in a different process with a
 * different SDK boundary; no bridge-vs-worker mixing is structurally
 * possible. This module narrows accordingly.
 */

import type { BridgeAppHandle } from "./bridge-app.ts";

/** Tag identifying the bridge handle origin at the type level. */
export type AppHandleTag = "bridge";

/**
 * Branded bridge handle. Bridge-side helpers that accept a tagged
 * handle declare this type; the structural absence of any `send`
 * member on `BridgeAppHandle` is preserved by the brand.
 */
export type TaggedBridgeHandle = BridgeAppHandle & { readonly __tag: "bridge" };

/**
 * Re-tag a `BridgeAppHandle` with its discriminator. Called once at
 * `bootBridgeApp` resolution.
 */
export function tagBridge(handle: BridgeAppHandle): TaggedBridgeHandle {
  // The brand is type-level only. `__tag` is a runtime marker so downstream
  // switches can discriminate AND the value survives JSON-serialization for
  // observability dumps. The returned object freezes the discriminator so a
  // caller cannot reassign it and defeat the tag.
  return Object.freeze({ ...handle, __tag: "bridge" as const });
}
