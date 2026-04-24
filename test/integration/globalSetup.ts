/**
 * test/integration/globalSetup — vitest globalSetup for MoltZap integration.
 *
 * Anchors: sbd#170 SPEC rev 2, §5 CI-fixture bullet (a)-(f); Spike B verdict
 * (sbd#182).
 *
 * Spec-binding constraints this module realizes:
 *   (a) subprocess backed by `node ~/moltzap/packages/server/dist/standalone.js`
 *   (b) PGlite (no docker, no external DB)
 *   (c) fresh subprocess per suite — NOT per test (12–15 s cold boot)
 *   (d) `ENCRYPTION_MASTER_SECRET` sourced as 32-byte base64 at suite setup
 *   (e) subprocess SIGTERMed at suite teardown
 *   (f) tests reach the server over HTTP+WS at `localhost:<port>`
 *
 * Pre-req (operator note): `pnpm install && pnpm build` in `~/moltzap/` has
 * been run once. The setup fails fast with a named error if the standalone
 * binary is missing.
 *
 * Architect stage — body throws.
 */

export interface MoltzapTestServerHandle {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly pid: number;
}

export type GlobalSetupError =
  | { readonly _tag: "StandaloneBinaryMissing"; readonly expectedPath: string }
  | { readonly _tag: "BootTimeout"; readonly waitedMs: number }
  | { readonly _tag: "UnexpectedSubprocessExit"; readonly exitCode: number; readonly stderr: string }
  | { readonly _tag: "EncryptionSecretInvalid"; readonly reason: string };

/**
 * vitest calls this once before the suite runs. Returns a teardown function
 * that vitest invokes after the suite completes.
 *
 * Impl contract:
 *   1. Resolve path to `~/moltzap/packages/server/dist/standalone.js`.
 *   2. Generate 32-byte base64 via `openssl rand -base64 32` (or equivalent).
 *   3. Spawn the subprocess with env `ENCRYPTION_MASTER_SECRET`,
 *      `MOLTZAP_CONFIG`, `PORT=0` (or fixed).
 *   4. Poll HTTP `/health` (or equivalent) until 200 or `BootTimeout`.
 *   5. Publish `MOLTZAP_TEST_HTTP_BASE` + `MOLTZAP_TEST_WS_BASE` to `globalThis`
 *      so test files can read them.
 *   6. Return teardown that SIGTERMs the pid.
 */
export default function setup(): Promise<() => Promise<void>> {
  throw new Error("not implemented");
}
