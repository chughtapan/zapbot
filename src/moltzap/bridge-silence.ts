/**
 * moltzap/bridge-silence — type-level encoding of the bridge silence
 * invariant.
 *
 * Anchors: sbd#199 acceptance item 7 (bridge silent at app layer per
 * A+C(2) operator decision).
 *
 * The bridge is a participant on every manifest conversation (upstream
 * forces `apps/create` callers to be participants — Round 1 finding on
 * sbd#197). The silence invariant is therefore not server-enforceable
 * from zapbot's side; it is a code-level rule the architecture
 * encodes via TYPE separation:
 *
 *   - `BridgeAppHandle` (in `bridge-app.ts`) has NO `send`, `sendOnKey`,
 *     or `reply` exports.
 *   - `WorkerAppHandle` (in `worker-app.ts`) carries the send surface.
 *   - The MCP adapter (`mcp-adapter.ts`) accepts only `WorkerAppHandle`
 *     when forwarding `reply` traffic; passing a `BridgeAppHandle`
 *     where a `WorkerAppHandle` is expected is a compile-time error.
 *
 * This module owns the discriminator type that prevents mixing the two
 * handles. It is small but load-bearing: it is the type-system
 * embodiment of Principle 1 ("types beat tests") applied to the silence
 * rule. Without the discriminator, a future contributor could pass the
 * bridge handle into a worker-shaped function and silently make the
 * bridge author messages.
 *
 * **What this module does NOT do:** detect runtime sends from the
 * bridge. That detection lives in the integration test
 * `test/moltzap-bridge-silence.test.ts`, which asserts no
 * `messages/send` RPC is ever issued from the bridge process during a
 * full session lifecycle.
 */

import type { BridgeAppHandle } from "./bridge-app.ts";
import type { WorkerAppHandle } from "./worker-app.ts";

/** Tag distinguishing handle origins at the type level. */
export type AppHandleTag = "bridge" | "worker";

/** Discriminated union of legal app-layer participants. */
export type AnyAppHandle =
  | (BridgeAppHandle & { readonly __tag: "bridge" })
  | (WorkerAppHandle & { readonly __tag: "worker" });

/**
 * Re-tag a `BridgeAppHandle` with its discriminator. Called once at
 * `bootBridgeApp` resolution.
 */
export function tagBridge(
  handle: BridgeAppHandle,
): BridgeAppHandle & { readonly __tag: "bridge" } {
  throw new Error("not implemented");
}

/**
 * Re-tag a `WorkerAppHandle` with its discriminator. Called once at
 * `joinWorkerSession` resolution.
 */
export function tagWorker(
  handle: WorkerAppHandle,
): WorkerAppHandle & { readonly __tag: "worker" } {
  throw new Error("not implemented");
}

/**
 * Type-level guarantee. Implementations of `mcp-adapter.ts`, the
 * `RosterManager`, and the budget coordinator that need to dispatch
 * REPLIES use this guard to reject the bridge handle at compile time.
 *
 *     function reply(handle: WorkerAppHandle, …) { … }
 *     reply(bridgeHandle, …) // compile error: bridge has no `role` field
 *
 * A runtime variant for code paths that legitimately accept either
 * (e.g., observability that calls `onMessage` on both) accepts
 * `AnyAppHandle` and switches on `__tag` with `absurd(handle)` in the
 * default branch.
 */
export function requireWorker(handle: AnyAppHandle): WorkerAppHandle {
  throw new Error("not implemented");
}
