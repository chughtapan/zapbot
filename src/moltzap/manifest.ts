/**
 * moltzap/manifest — `AppIdentity` + env decode only.
 *
 * Anchors: sbd#199 rev 4 §2 "Carry-over from sbd#186 baseline" — keep
 * `AppIdentity` + `loadAppIdentity`. The per-role manifest builders
 * (`buildOrchestratorManifest`, `buildWorkerManifest`,
 * `permissionsForRole`, `conversationBlock`, `verifyManifestKeys`) are
 * superseded by `union-manifest.ts` under zapbot#336 path (b): only the
 * bridge registers a manifest, and it registers the full union. Worker
 * processes never call `apps/register`.
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

export type AppIdentityDecodeError = {
  readonly _tag: "AppIdentityDecodeError";
  readonly reason: string;
};

const DEFAULT_DISPLAY_NAME = "zapbot-bridge";
const DEFAULT_DESCRIPTION =
  "zapbot bridge process MoltZap app (ws2 MVP per sbd#170)";

const MAX_DISPLAY_NAME_LEN = 128;
const MAX_DESCRIPTION_LEN = 512;

/**
 * Principle 2 boundary. Decode env → typed identity. Env vars:
 *   `ZAPBOT_MOLTZAP_BRIDGE_AGENT_NAME` → `displayName` (optional;
 *       default `"zapbot-bridge"`).
 *   `ZAPBOT_MOLTZAP_BRIDGE_APP_DESCRIPTION` → `description` (optional;
 *       default documentation string).
 * Bounds are enforced here so later code paths consume known-safe strings.
 */
export function loadAppIdentity(
  env: Record<string, string | undefined>,
): AppIdentity | AppIdentityDecodeError {
  const rawName = env.ZAPBOT_MOLTZAP_BRIDGE_AGENT_NAME;
  const displayName =
    typeof rawName === "string" && rawName.trim().length > 0
      ? rawName.trim()
      : DEFAULT_DISPLAY_NAME;
  if (displayName.length > MAX_DISPLAY_NAME_LEN) {
    return {
      _tag: "AppIdentityDecodeError",
      reason: `ZAPBOT_MOLTZAP_BRIDGE_AGENT_NAME exceeds ${MAX_DISPLAY_NAME_LEN} chars`,
    };
  }

  const rawDesc = env.ZAPBOT_MOLTZAP_BRIDGE_APP_DESCRIPTION;
  const description =
    typeof rawDesc === "string" && rawDesc.trim().length > 0
      ? rawDesc.trim()
      : DEFAULT_DESCRIPTION;
  if (description.length > MAX_DESCRIPTION_LEN) {
    return {
      _tag: "AppIdentityDecodeError",
      reason: `ZAPBOT_MOLTZAP_BRIDGE_APP_DESCRIPTION exceeds ${MAX_DESCRIPTION_LEN} chars`,
    };
  }

  return { appId: ZAPBOT_APP_ID, displayName, description };
}
