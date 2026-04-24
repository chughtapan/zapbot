/**
 * moltzap — barrel.
 *
 * Post-sbd#172 transplant: bridge, lifecycle, listener, supervisor, and
 * channel-runtime moved into `@moltzap/claude-code-channel` or were
 * subsumed by `@moltzap/client`. What remains is zapbot's consuming surface
 * (env decode, allowlist policy, role topology).
 */

export * from "./types.ts";
export * from "./identity-allowlist.ts";
export * from "./runtime.ts";
// session-client's binary SessionRole (orchestrator|worker) coexists with
// session-role's 4-value SessionRole; re-export everything from
// session-client EXCEPT the name that collides.
export {
  loadSessionClientEnv,
  type SessionClientEnv,
  type SessionClientConfigError,
} from "./session-client.ts";
export * from "./session-role.ts";
export * from "./role-topology.ts";
