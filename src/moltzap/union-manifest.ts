/**
 * moltzap/union-manifest — single bridge-owned AppManifest.
 *
 * Anchors: sbd#199 acceptance items 4 (AppManifest shape) and 8
 * (zapbot#336 resolution path b — single manifest registration). This
 * SUPERSEDES the per-role builders in `manifest.ts` (`buildOrchestratorManifest`
 * and `buildWorkerManifest`); both are deleted in the corresponding
 * `implement-staff` PR.
 *
 * **zapbot#336 resolution (architect call): path (b) — single bridge-owned
 * manifest registration.**
 *
 * Rationale:
 * - Per A+C(2) operator decision, only the bridge process holds a
 *   long-lived `MoltZapApp` and only the bridge calls `apps/register`.
 *   Workers never invoke `apps/register`, so per-role appIds are not
 *   needed: there is exactly one registrant.
 * - Last-writer-wins on the server's manifest store
 *   (`packages/server/src/app/app-host.ts:325`) is moot when there is
 *   only one writer.
 * - Per-role manifests would still let workers stomp the bridge's
 *   manifest if any worker called `apps/register` directly (today they
 *   do, via `bootApp`); single bridge-owned registration eliminates the
 *   stomp by construction (Principle 1: encode the constraint in the
 *   architecture, not in caller discipline).
 *
 * Trade-off accepted: the union manifest declares ALL 5 conversation
 * keys with `participantFilter: "all"`. Every invited worker is admitted
 * to every key the manifest declares — least-privilege at the key level
 * is provided by the zapbot SEND-side gate (`sendableKeysForRole` in
 * `app-client.ts`), not by the manifest. Consistent with OQ #3
 * resolution from spec rev 2 (per-role-pair keys carry directionality;
 * no client-side receive gate).
 */

import type { AppManifest } from "@moltzap/app-sdk";
import type { AppIdentity } from "./manifest.ts";

/**
 * Build the single bridge-owned union manifest. Declares every key in
 * `ALL_CONVERSATION_KEYS` with `participantFilter: "all"`.
 *
 * The bridge passes this manifest to `new MoltZapApp({ manifest })` at
 * boot. Workers do NOT pass a manifest; they connect raw and join
 * sessions the bridge created (see `worker-app.ts`).
 *
 * Principle 4 exhaustiveness: implementation iterates
 * `ALL_CONVERSATION_KEYS` so adding a new `ConversationKey` is a
 * compile-time-detectable inclusion in the manifest.
 */
export function buildUnionManifest(identity: AppIdentity): AppManifest {
  throw new Error("not implemented");
}

/**
 * Verify a manifest declares the full union (all 5 keys). Replaces
 * `verifyManifestKeys` for the bridge-side path; the worker-side path
 * has no manifest to verify.
 */
export type UnionManifestMismatch = {
  readonly _tag: "UnionManifestMismatch";
  readonly missing: readonly string[];
  readonly extra: readonly string[];
};

export function verifyUnionManifest(
  manifest: AppManifest,
): UnionManifestMismatch | null {
  throw new Error("not implemented");
}
