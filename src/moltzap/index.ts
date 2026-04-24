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

// sbd#199 architect cycle (bridge identity per A+C(2) + zapbot#336 path b
// + literal-string fallback removal). Stubs only; bodies are implemented
// by the corresponding implement-staff PR. Carried alongside the sbd#186
// stubs above so consumers can transition from `bootApp(role)` to
// `bootBridgeApp` / `joinWorkerSession` in a single PR.
export * from "./bridge-identity.ts";
export * from "./bridge-app.ts";
export * from "./worker-app.ts";
export * from "./bridge-silence.ts";
export * from "./union-manifest.ts";
