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
 * to every key the manifest declares. There is NO per-key send-side gate
 * in v1 — workers use the `@moltzap/claude-code-channel` plugin whose
 * MCP `reply` tool targets the inbound's `chat_id`, so "which key to
 * publish on" is not a caller-facing decision. Directional flow is
 * enforced by (a) the bridge's `apps/create({invitedAgentIds})`
 * admission control, (b) the channel-plugin's reply-on-inbound
 * semantic, and (c) publisher-code convention — see rev 4 §5.5 + §8.6
 * for the trust-boundary acceptance.
 *
 * §8.2 (rev 4): 5 directional keys retained; `coord-worker-to-orch` is
 * a **dead key** in v1 (no organic publisher under reply-on-inbound —
 * nothing publishes first on that key, so workers never receive an
 * inbound `chat_id` there to reply against). It is declared in the
 * manifest for spec-churn minimization and migration-footprint
 * preservation; revisit if a concrete orchestrator-initiated worker
 * push appears.
 */

import type { AppManifest } from "@moltzap/app-sdk";
import type { AppIdentity } from "./manifest.ts";
import { ALL_CONVERSATION_KEYS } from "./conversation-keys.ts";

/**
 * Build the single bridge-owned union manifest. Declares every key in
 * `ALL_CONVERSATION_KEYS` with `participantFilter: "all"`.
 *
 * The bridge passes this manifest to `new MoltZapApp({ manifest })` at
 * boot. Workers do NOT pass a manifest; they connect via
 * `@moltzap/claude-code-channel`'s `bootClaudeCodeChannel(...)` and are
 * admitted to bridge-owned conversations by prior
 * `apps/create({invitedAgentIds})` calls (see `worker-channel.ts`).
 *
 * Principle 4 exhaustiveness: implementation iterates
 * `ALL_CONVERSATION_KEYS` so adding a new `ConversationKey` is a
 * compile-time-detectable inclusion in the manifest.
 */
export function buildUnionManifest(identity: AppIdentity): AppManifest {
  return {
    appId: identity.appId,
    name: identity.displayName,
    description: identity.description,
    permissions: {
      required: [],
      optional: [],
    },
    conversations: ALL_CONVERSATION_KEYS.map((key) => ({
      key,
      name: key,
      participantFilter: "all" as const,
    })),
  };
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
  const expected = new Set<string>(ALL_CONVERSATION_KEYS as readonly string[]);
  const declared = new Set<string>(
    (manifest.conversations ?? []).map((c) => c.key),
  );

  const missing: string[] = [];
  for (const key of expected) {
    if (!declared.has(key)) missing.push(key);
  }
  const extra: string[] = [];
  for (const key of declared) {
    if (!expected.has(key)) extra.push(key);
  }
  if (missing.length === 0 && extra.length === 0) return null;
  // Keep extras stable for snapshot-style assertions.
  extra.sort();
  missing.sort();
  return {
    _tag: "UnionManifestMismatch",
    missing,
    extra,
  };
}

