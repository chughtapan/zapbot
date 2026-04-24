/**
 * test/integration/vitest.integration.config — integration-suite vitest config.
 *
 * Anchors: sbd#170 SPEC rev 2, §5 "CI integration fixture (post-Spike B,
 * operator-binding constraints)"; Spike B verdict (sbd#182): vitest
 * `globalSetup` + `standalone.js` subprocess + PGlite + 32-byte base64
 * `ENCRYPTION_MASTER_SECRET` + SIGTERM teardown.
 *
 * Implementation reads `globalSetup` from `./globalSetup.ts` and sets
 * `testTimeout` high enough to amortize the 12–15 s cold boot budget.
 * Run with: `bun x vitest --config test/integration/vitest.integration.config.ts`.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/integration/**/*.integration.test.ts"],
    // Spike B: cold boot is 12-15s; tests themselves are fast. 45s
    // per-test is a generous floor that still surfaces hangs.
    testTimeout: 45_000,
    hookTimeout: 45_000,
    globalSetup: ["test/integration/globalSetup.ts"],
    // Integration tests share a single server process; run serially
    // within a file to avoid race conditions on the ambient session.
    fileParallelism: false,
    pool: "forks",
  },
});
