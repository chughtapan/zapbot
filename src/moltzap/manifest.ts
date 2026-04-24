/**
 * moltzap/manifest — role-scoped AppManifest builders.
 *
 * Anchors: sbd#170 SPEC rev 2, §5 bullets on bridge/worker `MoltZapApp`
 * construction; OQ #4 resolution (one manifest per role, bridge = orchestrator
 * manifest, each worker = role-specific manifest); Invariants 2, 5.
 *
 * OQ #4 decision (binding): one `AppManifest` per `SessionRole`. Bridge
 * constructs `buildOrchestratorManifest()`; each worker constructs
 * `buildWorkerManifest(role)`. Role-scoped manifests declare ONLY the
 * conversation keys the role legitimately participates in (per the role-pair
 * binding table in `conversation-keys.ts`), giving least-privilege
 * declaration at the manifest boundary.
 *
 * Invariant 5 (session-level admission) is server-enforced via the bridge
 * manifest's `participantFilter` fields + `permissions`. Spec uses only
 * `"all"` and `"initiator"`; `"none"` is not relied on (Spike C caveat).
 */

import type {
  AppManifest,
  AppManifestConversation,
  AppPermission,
} from "@moltzap/app-sdk";
import { absurd } from "../types.ts";
import type { SessionRole } from "./session-role.ts";
import type { ConversationKey } from "./conversation-keys.ts";
import {
  ALL_CONVERSATION_KEYS,
  receivableKeysForRole,
  sendableKeysForRole,
} from "./conversation-keys.ts";

// ── App identity ────────────────────────────────────────────────────

/**
 * Zapbot's `appId` for `apps/register`. One global constant so every process
 * (bridge and workers) registers against the same app. Implementations read
 * it from env via `loadAppIdentity`.
 */
export const ZAPBOT_APP_ID = "zapbot-ws2" as const;

const DEFAULT_DISPLAY_NAME = "zapbot";
const DEFAULT_DESCRIPTION =
  "zapbot multi-agent coordination (WS2 MVP)";

export interface AppIdentity {
  readonly appId: typeof ZAPBOT_APP_ID;
  readonly displayName: string;
  readonly description: string;
}

export type AppIdentityDecodeError = {
  readonly _tag: "AppIdentityDecodeError";
  readonly reason: string;
};

/**
 * Principle 2 boundary. Decode env → typed identity.
 *
 * Env:
 *   `ZAPBOT_MOLTZAP_APP_DISPLAY_NAME` — optional; defaults to "zapbot".
 *   `ZAPBOT_MOLTZAP_APP_DESCRIPTION`  — optional; defaults to canned text.
 *
 * `appId` is not configurable; spec OQ #3 resolution holds it constant.
 */
export function loadAppIdentity(
  env: Record<string, string | undefined>,
): AppIdentity | AppIdentityDecodeError {
  const displayNameRaw = env.ZAPBOT_MOLTZAP_APP_DISPLAY_NAME;
  const descriptionRaw = env.ZAPBOT_MOLTZAP_APP_DESCRIPTION;
  const displayName =
    typeof displayNameRaw === "string" && displayNameRaw.trim().length > 0
      ? displayNameRaw.trim()
      : DEFAULT_DISPLAY_NAME;
  const description =
    typeof descriptionRaw === "string" && descriptionRaw.trim().length > 0
      ? descriptionRaw.trim()
      : DEFAULT_DESCRIPTION;
  if (displayName.length > 128) {
    return {
      _tag: "AppIdentityDecodeError",
      reason: "ZAPBOT_MOLTZAP_APP_DISPLAY_NAME must be <= 128 chars",
    };
  }
  return {
    appId: ZAPBOT_APP_ID,
    displayName,
    description,
  };
}

// ── Permissions ─────────────────────────────────────────────────────

/**
 * The zapbot permission set, declared once. Per-role manifests project a
 * subset via `permissionsForRole`.
 *
 * Architect OQ #2 default (binding): `permissions.required = []`,
 * `permissions.optional = []`. Zapbot does not consume `on_join` or skill
 * challenges; an empty permission set is the minimal shape the server
 * accepts. If future features require a permission (e.g., a custom skill
 * URL), they are added here with spec anchors.
 */
export function getZapbotPermissions(): {
  readonly required: readonly AppPermission[];
  readonly optional: readonly AppPermission[];
} {
  return { required: [], optional: [] };
}

export function permissionsForRole(_role: SessionRole): {
  readonly required: readonly AppPermission[];
  readonly optional: readonly AppPermission[];
} {
  // OQ #2 default: role-uniform empty permission set for v1. If per-role
  // scoping is ever needed, the split happens here.
  return getZapbotPermissions();
}

// ── Conversation block builders ─────────────────────────────────────

const KEY_DISPLAY_NAMES: Record<ConversationKey, string> = {
  "coord-orch-to-worker": "Orchestrator → Worker",
  "coord-worker-to-orch": "Worker → Orchestrator",
  "coord-architect-peer": "Architect ⇄ Architect",
  "coord-implementer-to-architect": "Implementer → Architect",
  "coord-review-to-author": "Reviewer → Author",
};

/**
 * Build an `AppManifestConversation` block for `key`. `participantFilter` is
 * one of `"all" | "initiator"` (Invariant 5 + Spike C: `"none"` is not
 * relied on).
 */
export function conversationBlock(
  key: ConversationKey,
  participantFilter: "all" | "initiator",
): AppManifestConversation {
  return {
    key,
    name: KEY_DISPLAY_NAMES[key],
    participantFilter,
  };
}

// ── Role-scoped manifests ───────────────────────────────────────────

/**
 * Build the bridge's orchestrator manifest. Declares ALL 5 conversation
 * keys; this is the manifest the server uses at `apps/create` time to
 * materialize the session's conversation topology.
 *
 * OQ #4 tie: "bridge uses the orchestrator manifest."
 * Invariant 2 tie: "AppManifest is the source of truth for conversation keys."
 */
export function buildOrchestratorManifest(
  identity: AppIdentity,
): AppManifest {
  const perms = permissionsForRole("orchestrator");
  return {
    appId: identity.appId,
    name: identity.displayName,
    description: identity.description,
    permissions: {
      required: [...perms.required],
      optional: [...perms.optional],
    },
    conversations: ALL_CONVERSATION_KEYS.map((key) =>
      conversationBlock(key, "all"),
    ),
  };
}

/**
 * Build a worker manifest. Declares ONLY the keys the role legitimately
 * sends or receives on, per `conversation-keys.ts` bindings.
 *
 * OQ #4 tie: each worker uses a role-specific manifest declaring only the
 * conversation keys that role legitimately participates in.
 */
export function buildWorkerManifest(
  identity: AppIdentity,
  role: Exclude<SessionRole, "orchestrator">,
): AppManifest {
  const keys = keysForWorkerRole(role);
  const perms = permissionsForRole(role);
  return {
    appId: identity.appId,
    name: `${identity.displayName} (${role})`,
    description: identity.description,
    permissions: {
      required: [...perms.required],
      optional: [...perms.optional],
    },
    conversations: keys.map((key) => conversationBlock(key, "all")),
  };
}

/**
 * The union of send-able and receive-able keys for a worker role. The server
 * driving session topology is the bridge's orchestrator manifest; this list
 * bounds what the worker's own SDK will declare as in-scope.
 */
export function keysForWorkerRole(
  role: Exclude<SessionRole, "orchestrator">,
): readonly ConversationKey[] {
  const set = new Set<ConversationKey>([
    ...sendableKeysForRole(role),
    ...receivableKeysForRole(role),
  ]);
  // Preserve the canonical enumeration order of ALL_CONVERSATION_KEYS.
  return ALL_CONVERSATION_KEYS.filter((k) => set.has(k));
}

/**
 * Verify that `manifest` declares exactly the keys `expected`. Invariant 2
 * gate called at `bootApp`; divergence is a boot-time error.
 */
export type ManifestKeyMismatch = {
  readonly _tag: "ManifestKeyMismatch";
  readonly expected: readonly ConversationKey[];
  readonly declared: readonly string[];
};

export function verifyManifestKeys(
  manifest: AppManifest,
  expected: readonly ConversationKey[],
): ManifestKeyMismatch | null {
  const declared = (manifest.conversations ?? []).map(
    (c: AppManifestConversation) => c.key,
  );
  const expectedSorted = [...expected].sort();
  const declaredSorted = [...declared].sort();
  if (expectedSorted.length !== declaredSorted.length) {
    return {
      _tag: "ManifestKeyMismatch",
      expected,
      declared,
    };
  }
  for (let i = 0; i < expectedSorted.length; i++) {
    if (expectedSorted[i] !== declaredSorted[i]) {
      return {
        _tag: "ManifestKeyMismatch",
        expected,
        declared,
      };
    }
  }
  return null;
}

/**
 * The expected conversation-key set for a given role. Used by `bootApp` to
 * reconcile the manifest it built against `verifyManifestKeys`.
 */
export function expectedKeysForRole(
  role: SessionRole,
): readonly ConversationKey[] {
  switch (role) {
    case "orchestrator":
      return ALL_CONVERSATION_KEYS;
    case "architect":
    case "implementer":
    case "reviewer":
      return keysForWorkerRole(role);
    default:
      return absurd(role);
  }
}
