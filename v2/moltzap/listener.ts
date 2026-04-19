/**
 * v2/moltzap/listener — moltzap app-SDK inbound-registration wrapper.
 *
 * Anchors: sbd#108 architect plan §2.2 listener, §3 Interfaces; spec
 * moltzap-channel-v1 §7 Q2 option (a).
 *
 * Forbidden to attach before `MOLTZAP_READY`. Raw SDK events are decoded
 * through a schema here before reaching the bridge callback; malformed events
 * are dropped with a tagged diagnostic — no throw, no buffer (I7).
 */

import type { Result } from "../types.ts";
import { err, ok } from "../types.ts";
import type { LifecycleState, ListenerRegistrationError } from "./lifecycle.ts";
import {
  asMoltzapConversationId,
  asMoltzapMessageId,
  asMoltzapSenderId,
} from "./types.ts";
import type {
  ListenerHandle,
  MoltzapConversationId,
  MoltzapInbound,
  MoltzapMessageId,
  MoltzapSdkHandle,
  MoltzapSenderId,
} from "./types.ts";

// ── Decode error ─────────────────────────────────────────────────────
//
// sbd#108 follow-up: "typed error for malformed events". Named per field
// so the diagnostic sink can surface exactly which part of the raw SDK
// event was wrong without leaking large payloads.

export type DecodeError = {
  readonly _tag: "DecodeError";
  /** The field path that failed validation ("." for non-object input). */
  readonly field: "." | "messageId" | "conversationId" | "senderId" | "bodyText" | "receivedAtMs";
  /** The raw value that failed. */
  readonly raw: unknown;
};

/** Injection point for the decode diagnostic. Plugin boot wires stderr;
 *  tests inject a recorder. Kept synchronous (diagnostic only). */
export type DecodeErrorSink = (error: DecodeError) => void;

// ── Registrar injection point ────────────────────────────────────────
//
// The registrar receives a callback typed `(event: unknown) => void`.
// This places schema validation inside this module (Principle 2: validate
// at every boundary) rather than trusting the boot-layer to pre-shape events.

export type MoltzapRegistrar = (
  sdk: MoltzapSdkHandle,
  cb: (event: unknown) => void,
) => Promise<Result<ListenerHandle, { readonly _tag: "SDKRejected"; readonly cause: unknown }>>;

// ── Registration ─────────────────────────────────────────────────────

/**
 * Register the inbound callback against the moltzap SDK.
 *
 * Pre-conditions:
 *   - `state` must be `MOLTZAP_READY` (option (a) from spec §7 Q2).
 *   - `registrar` is the caller-supplied adapter to `@moltzap/app-sdk`.
 *
 * The callback supplied to `registrar` validates each raw SDK event
 * through `decodeMoltzapInbound` before forwarding to `cb`. Invalid
 * events are reported to `diag` and dropped (no buffer — I7).
 */
export async function register(
  state: LifecycleState,
  sdk: MoltzapSdkHandle,
  cb: (event: MoltzapInbound) => void,
  registrar: MoltzapRegistrar,
  diag: DecodeErrorSink,
): Promise<Result<ListenerHandle, ListenerRegistrationError>> {
  if (state._tag !== "MOLTZAP_READY") {
    return err({ _tag: "NotReady", state });
  }
  // Wrap cb with the decode layer. The registrar passes raw SDK events;
  // we validate the shape here before the bridge ever sees them.
  const wrappedCb = (raw: unknown): void => {
    const decoded = decodeMoltzapInbound(raw);
    if (decoded._tag === "Err") {
      diag(decoded.error);
      return;
    }
    cb(decoded.value);
  };
  try {
    return await registrar(sdk, wrappedCb);
  } catch (cause) {
    return err({ _tag: "SDKRejected", cause });
  }
}

// ── Decoder ──────────────────────────────────────────────────────────
//
// Extra fields are silently ignored (forward-compat with SDK additions).

function decodeMoltzapInbound(raw: unknown): Result<MoltzapInbound, DecodeError> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return err({ _tag: "DecodeError", field: ".", raw });
  }
  const r = raw as Record<string, unknown>;
  // ?? short-circuits: returns the first field error encountered, at most one per event.
  const fieldErr =
    checkField(r, "messageId", "string") ??
    checkField(r, "conversationId", "string") ??
    checkField(r, "senderId", "string") ??
    checkField(r, "bodyText", "string") ??
    checkField(r, "receivedAtMs", "number");
  if (fieldErr) return err(fieldErr);
  return ok({
    messageId: asMoltzapMessageId(r["messageId"] as string),
    conversationId: asMoltzapConversationId(r["conversationId"] as string),
    senderId: asMoltzapSenderId(r["senderId"] as string),
    bodyText: r["bodyText"] as string,
    receivedAtMs: r["receivedAtMs"] as number,
  });
}

function checkField(
  r: Record<string, unknown>,
  field: "messageId" | "conversationId" | "senderId" | "bodyText" | "receivedAtMs",
  type: "string" | "number",
): DecodeError | null {
  return typeof r[field] !== type ? { _tag: "DecodeError", field, raw: r[field] } : null;
}
