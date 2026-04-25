/**
 * moltzap/types — brands still used by zapbot after the
 * `@moltzap/claude-code-channel` extraction.
 *
 * Research verdict sbd#173 §(b) "DELETES from zapbot" table noted the
 * original module as deletable "with brand-only residue" once the bridge,
 * lifecycle, listener, supervisor, channel-runtime, and claude-channel
 * modules moved upstream or were subsumed by `@moltzap/client`. The
 * residue is this file: brand tags and their coercers, kept because
 * `bridge-app.ts`, `bridge-identity.ts`, `orchestrator/*.ts`, and
 * `runtime.ts` compile against `MoltzapSenderId`.
 *
 * Removed: `MoltzapInbound`, `MoltzapInboundMeta`, `ListenerHandle`,
 * `MoltzapSdkHandle`, `McpContext`, `MoltzapSdkContext` — all consumed
 * exclusively by the deleted zapbot-local architect-phase stubs.
 */

export type MoltzapMessageId = string & { readonly __brand: "MoltzapMessageId" };
export type MoltzapConversationId = string & { readonly __brand: "MoltzapConversationId" };
export type MoltzapSenderId = string & { readonly __brand: "MoltzapSenderId" };

export function asMoltzapMessageId(s: string): MoltzapMessageId {
  return s as MoltzapMessageId;
}
export function asMoltzapConversationId(s: string): MoltzapConversationId {
  return s as MoltzapConversationId;
}
export function asMoltzapSenderId(s: string): MoltzapSenderId {
  return s as MoltzapSenderId;
}

/** Exhaustiveness helper (mirrors `src/types.ts`). */
export function absurd(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
