/**
 * v2/moltzap/listener — moltzap app-SDK inbound-registration wrapper.
 *
 * Anchors: sbd#108 architect plan §2.2 listener, §3 Interfaces; spec
 * moltzap-channel-v1 §7 Q2 option (a).
 *
 * Forbidden to attach before `MOLTZAP_READY`. The SDK surface is opaque here
 * (see types.ts MoltzapSdkHandle); the actual adapter that wires
 * `MoltZapApp.onMessage` to this callback lives at the plugin boot layer and
 * is injected as `MoltzapRegistrar`.
 */

import type { Result } from "../types.ts";
import { err, ok } from "../types.ts";
import type { LifecycleState, ListenerRegistrationError } from "./lifecycle.ts";
import type {
  ListenerHandle,
  MoltzapInbound,
  MoltzapSdkHandle,
} from "./types.ts";

/**
 * The injection point for the real SDK wiring. The plugin boot code supplies
 * an implementation that calls `@moltzap/app-sdk`'s `onMessage`/`onSessionReady`
 * and returns an opaque handle. Keeping this as a caller-supplied function
 * lets lifecycle and listener compile without a hard dep on
 * `@moltzap/app-sdk`; architect plan §3 explicitly calls the SDK type opaque.
 */
export type MoltzapRegistrar = (
  sdk: MoltzapSdkHandle,
  cb: (event: MoltzapInbound) => void,
) => Promise<Result<ListenerHandle, { readonly _tag: "SDKRejected"; readonly cause: string }>>;

/**
 * Register the inbound callback against the moltzap SDK.
 *
 * Pre-conditions:
 *   - `state` must be `MOLTZAP_READY` (option (a) from spec §7 Q2).
 *   - `registrar` is the caller-supplied adapter to `@moltzap/app-sdk`.
 *
 * Returns `NotReady` before the ready gate (prevents the debt pattern of
 * "register eagerly, rely on SDK internals" — spec §4 I6, architect plan §4).
 */
export async function register(
  state: LifecycleState,
  sdk: MoltzapSdkHandle,
  cb: (event: MoltzapInbound) => void,
  registrar: MoltzapRegistrar,
): Promise<Result<ListenerHandle, ListenerRegistrationError>> {
  // Architect plan §2.2: register exactly once, only in MOLTZAP_READY.
  // LISTENING/any other state → NotReady.
  if (state._tag !== "MOLTZAP_READY") {
    return err({ _tag: "NotReady", state });
  }
  const result = await registrar(sdk, cb);
  if (result._tag === "Ok") {
    return ok(result.value);
  }
  return err(result.error);
}
