/**
 * v2/moltzap/lifecycle — moltzap Channels bridge state machine.
 *
 * Anchors: sbd#108 architect plan §2.1 lifecycle, §3 Interfaces, §4 Data flow;
 * spec moltzap-channel-v1 §7 Q2 (option (a): register listener only after
 * MOLTZAP_READY).
 *
 * Single source of truth for "is the bridge ready." Three gates from INIT to
 * LISTENING; two terminal-ish exit states (DRAINING, STOPPED, FAILED).
 * Pure state algebra — no I/O, no side effects. Impl wires the transitions
 * from its event loop at the plugin boot boundary.
 */

import type { ListenerHandle } from "./types.ts";

// ── State ───────────────────────────────────────────────────────────

export type LifecycleState =
  | { readonly _tag: "INIT" }
  | { readonly _tag: "STDIO_CONNECTING" }
  | { readonly _tag: "STDIO_READY" }
  | { readonly _tag: "MOLTZAP_CONNECTING" }
  | { readonly _tag: "MOLTZAP_READY" }
  | { readonly _tag: "LISTENING"; readonly listener: ListenerHandle }
  | { readonly _tag: "DRAINING"; readonly reason: DrainReason }
  | { readonly _tag: "STOPPED" }
  | { readonly _tag: "FAILED"; readonly cause: LifecycleError };

export type DrainReason =
  | { readonly _tag: "SigTerm" }
  | { readonly _tag: "MoltzapDisconnect" }
  | { readonly _tag: "McpDisconnect" };

// ── Errors ──────────────────────────────────────────────────────────

export type LifecycleError =
  | { readonly _tag: "TransportConnectError"; readonly cause: string }
  | { readonly _tag: "MoltzapHandshakeError"; readonly cause: string }
  | { readonly _tag: "ListenerRegistrationError"; readonly cause: ListenerRegistrationError };

export type ListenerRegistrationError =
  | { readonly _tag: "NotReady"; readonly state: LifecycleState }
  | { readonly _tag: "SDKRejected"; readonly cause: string };

// ── Events ──────────────────────────────────────────────────────────

export type LifecycleEvent =
  | { readonly _tag: "StdioConnectStarted" }
  | { readonly _tag: "StdioConnected" }
  | { readonly _tag: "StdioFailed"; readonly cause: string }
  | { readonly _tag: "MoltzapConnectStarted" }
  | { readonly _tag: "MoltzapReady" }
  | { readonly _tag: "MoltzapFailed"; readonly cause: string }
  | { readonly _tag: "ListenerRegistered"; readonly handle: ListenerHandle }
  | { readonly _tag: "ListenerFailed"; readonly cause: ListenerRegistrationError }
  | { readonly _tag: "DrainRequested"; readonly reason: DrainReason }
  | { readonly _tag: "Stopped" };

// ── Transition result ───────────────────────────────────────────────

export type TransitionResult =
  | { readonly _tag: "Next"; readonly state: LifecycleState }
  | { readonly _tag: "Illegal"; readonly from: LifecycleState; readonly event: LifecycleEvent };

// ── Initial state ───────────────────────────────────────────────────

export const INITIAL: LifecycleState = { _tag: "INIT" };

// ── Transition function ─────────────────────────────────────────────
//
// The transition matrix is declared explicitly per (state, event) pair.
// Illegal pairs return `Illegal` rather than throwing — the caller (the
// plugin boot layer) decides whether to treat a specific illegal pair as
// a panic. Shutdown events (`DrainRequested`, `Stopped`) are accepted from
// any non-terminal state; everything else is state-gated.

export function transition(
  from: LifecycleState,
  event: LifecycleEvent,
): TransitionResult {
  // Shutdown fast-paths: accepted from any non-stopped, non-failed state.
  if (event._tag === "DrainRequested") {
    if (from._tag === "STOPPED" || from._tag === "FAILED" || from._tag === "DRAINING") {
      return illegal(from, event);
    }
    return next({ _tag: "DRAINING", reason: event.reason });
  }
  if (event._tag === "Stopped") {
    if (from._tag === "STOPPED") return illegal(from, event);
    return next({ _tag: "STOPPED" });
  }

  switch (from._tag) {
    case "INIT":
      if (event._tag === "StdioConnectStarted") return next({ _tag: "STDIO_CONNECTING" });
      return illegal(from, event);

    case "STDIO_CONNECTING":
      if (event._tag === "StdioConnected") return next({ _tag: "STDIO_READY" });
      if (event._tag === "StdioFailed") {
        return next({
          _tag: "FAILED",
          cause: { _tag: "TransportConnectError", cause: event.cause },
        });
      }
      return illegal(from, event);

    case "STDIO_READY":
      if (event._tag === "MoltzapConnectStarted") return next({ _tag: "MOLTZAP_CONNECTING" });
      return illegal(from, event);

    case "MOLTZAP_CONNECTING":
      if (event._tag === "MoltzapReady") return next({ _tag: "MOLTZAP_READY" });
      if (event._tag === "MoltzapFailed") {
        return next({
          _tag: "FAILED",
          cause: { _tag: "MoltzapHandshakeError", cause: event.cause },
        });
      }
      return illegal(from, event);

    case "MOLTZAP_READY":
      if (event._tag === "ListenerRegistered") {
        return next({ _tag: "LISTENING", listener: event.handle });
      }
      if (event._tag === "ListenerFailed") {
        return next({
          _tag: "FAILED",
          cause: { _tag: "ListenerRegistrationError", cause: event.cause },
        });
      }
      return illegal(from, event);

    case "LISTENING":
      // Terminal event types (DrainRequested, Stopped) handled above.
      // All other events in LISTENING are bugs from the driver: events that
      // belong to earlier states cannot legally re-fire here.
      return illegal(from, event);

    case "DRAINING":
      // Only Stopped (handled above) transitions out. All other events are
      // suppressed — the plugin is shutting down.
      return illegal(from, event);

    case "STOPPED":
    case "FAILED":
      return illegal(from, event);

    default:
      return absurd(from);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function next(state: LifecycleState): TransitionResult {
  return { _tag: "Next", state };
}

function illegal(from: LifecycleState, event: LifecycleEvent): TransitionResult {
  return { _tag: "Illegal", from, event };
}

function absurd(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}

// ── Ready probe ─────────────────────────────────────────────────────

export function isListening(state: LifecycleState): boolean {
  return state._tag === "LISTENING";
}

export function isMoltzapReady(state: LifecycleState): boolean {
  return state._tag === "MOLTZAP_READY" || state._tag === "LISTENING";
}
