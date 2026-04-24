/**
 * test/integration/vitest.integration.config — integration-suite vitest config.
 *
 * Anchors: sbd#170 SPEC rev 2, §5 "CI integration fixture (post-Spike B,
 * operator-binding constraints)"; Spike B verdict (sbd#182): vitest
 * `globalSetup` + `standalone.js` subprocess + PGlite + 32-byte base64
 * `ENCRYPTION_MASTER_SECRET` + SIGTERM teardown.
 *
 * Architect stage — body throws. Implementation reads `globalSetup` +
 * `globalTeardown` from the files in this directory and sets `testTimeout`
 * high enough to amortize the 12–15 s cold boot budget spike B measured.
 */

// Stub exists so implement-* can fill in. vitest will import the default
// export at runtime; the architect-stage body is a typed throw so an
// accidental test invocation fails loudly instead of silently picking up
// the unit-test config.

export default (function stub(): never {
  throw new Error("not implemented");
})();
