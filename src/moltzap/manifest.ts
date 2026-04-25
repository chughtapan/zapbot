/**
 * moltzap/manifest — `AppIdentity` + `buildAppIdentity`.
 *
 * Anchors: sbd#199 rev 4 §2 "Carry-over from sbd#186 baseline" — keep
 * `AppIdentity`. The per-role manifest builders
 * (`buildOrchestratorManifest`, `buildWorkerManifest`,
 * `permissionsForRole`, `conversationBlock`, `verifyManifestKeys`) are
 * superseded by `union-manifest.ts` under zapbot#336 path (b).
 *
 * Display name is decoded once by `bridge-identity.ts::loadBridgeIdentityEnv`;
 * this module's `buildAppIdentity` consumes that decoded value and
 * pairs it with an appId + description to form the AppManifest input.
 */

// ── App identity ────────────────────────────────────────────────────

/**
 * Zapbot's `appId` for `apps/register`. One global constant: the bridge
 * is the only process that registers, and it registers this id.
 */
export const ZAPBOT_APP_ID = "zapbot-ws2" as const;

export interface AppIdentity {
  readonly appId: typeof ZAPBOT_APP_ID;
  readonly displayName: string;
  readonly description: string;
}

const DEFAULT_DESCRIPTION =
  "zapbot bridge process MoltZap app (ws2 MVP per sbd#170)";

/**
 * Pair a pre-validated display name with the canonical app identity.
 * `displayName` is decoded upstream at the env boundary by
 * `loadBridgeIdentityEnv`; re-decoding it here would be a second
 * boundary and the two sites would drift.
 */
export function buildAppIdentity(displayName: string): AppIdentity {
  return {
    appId: ZAPBOT_APP_ID,
    displayName,
    description: DEFAULT_DESCRIPTION,
  };
}
