/**
 * moltzap — barrel.
 *
 * Post-sbd#172 transplant: bridge, lifecycle, listener, supervisor, and
 * channel-runtime moved into `@moltzap/claude-code-channel` or were
 * subsumed by `@moltzap/client`. Post-sbd#200 rev 4 cutover: bridge
 * ownership (bootBridgeApp), worker ownership (bootWorkerChannel),
 * bridge-owned union manifest (buildUnionManifest), and bridge silence
 * brand (tagBridge) replace the sbd#186 stubs (app-client, session-client).
 */

export * from "./types.ts";
export * from "./identity-allowlist.ts";
export * from "./runtime.ts";
export * from "./session-role.ts";
export * from "./role-topology.ts";
export * from "./manifest.ts";

// sbd#199 rev 4 — bridge/worker split per operator A+C(2) decision.
export * from "./bridge-identity.ts";
export * from "./bridge-app.ts";
export * from "./worker-channel.ts";
export * from "./bridge-silence.ts";
export * from "./union-manifest.ts";
