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
 * Invariant 5 (session-level admission) is server-enforced by the bridge
 * manifest's `participantFilter` fields + `permissions`. Worker manifests
 * share the same `appId`; the server's authoritative session topology comes
 * from the bridge's manifest at `apps/create` time.
 *
 * Architect stage — bodies throw.
 */

import type {
  AppManifest,
  AppManifestConversation,
  AppPermission,
} from "@moltzap/app-sdk";
import type { SessionRole } from "./session-role.ts";
import type { ConversationKey } from "./conversation-keys.ts";

// ── App identity ────────────────────────────────────────────────────

/**
 * Zapbot's `appId` for `apps/register`. One global constant so every process
 * (bridge and workers) registers against the same app. Implementations read
 * it from env via `loadAppIdentity`.
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

/** Principle 2 boundary. Decode env → typed identity. */
export function loadAppIdentity(
  env: Record<string, string | undefined>,
): AppIdentity | AppIdentityDecodeError {
  throw new Error("not implemented");
}

// ── Permissions ─────────────────────────────────────────────────────

/**
 * The zapbot permission set, declared once. Per-role manifests project a
 * subset of this via `permissionsForRole`. `permissions.required` vs
 * `permissions.optional` split is owned by the implement stage; the shape is
 * reused from `@moltzap/app-sdk`'s `AppPermission`.
 */
export function getZapbotPermissions(): {
  readonly required: readonly AppPermission[];
  readonly optional: readonly AppPermission[];
} {
  throw new Error("not implemented");
}

export function permissionsForRole(role: SessionRole): {
  readonly required: readonly AppPermission[];
  readonly optional: readonly AppPermission[];
} {
  throw new Error("not implemented");
}

// ── Conversation block builders ─────────────────────────────────────

/**
 * Build an `AppManifestConversation` block for `key`. `participantFilter`
 * is one of `"all" | "initiator"` (Invariant 5 + Spike C: `"none"` is not
 * relied on).
 *
 * Bridge (orchestrator) manifest uses `"all"` for every conversation so all
 * session-admitted agents are seeded into every conversation; role-pair
 * directionality is enforced structurally by which role-scoped manifest
 * declares which keys (sender side) plus the receive-key trust rule
 * (Invariant 6).
 */
export function conversationBlock(
  key: ConversationKey,
  participantFilter: "all" | "initiator",
): AppManifestConversation {
  throw new Error("not implemented");
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
  throw new Error("not implemented");
}

/**
 * Build a worker manifest. Declares ONLY the keys the role legitimately
 * sends or receives on, per `conversation-keys.ts` bindings.
 *
 * OQ #4 tie: "each worker uses a role-specific manifest declaring only the
 * conversation keys that role legitimately participates in."
 *
 * Note: the server's session topology is driven by the BRIDGE's manifest at
 * session-create time. A worker's role-scoped manifest is still registered
 * via `apps/register` against the worker's own agent credential; its keys
 * are the keys the worker's own `MoltZapApp` instance is authorized to use.
 * Role-scoping here bounds what the worker's SDK will send or subscribe to.
 */
export function buildWorkerManifest(
  identity: AppIdentity,
  role: Exclude<SessionRole, "orchestrator">,
): AppManifest {
  throw new Error("not implemented");
}

/**
 * Verify that `manifest` declares exactly the keys `expected`. Invariant 2
 * gate called at `ZapbotMoltZapApp` boot; divergence is a boot-time error.
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
  throw new Error("not implemented");
}
