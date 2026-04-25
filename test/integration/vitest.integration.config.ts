/**
 * test/integration/vitest.integration.config — integration-suite vitest config.
 *
 * Anchors: sbd#170 SPEC rev 2, §5 CI fixture bullet; Spike B verdict (sbd#182);
 * sbd#203 Phase 1.
 *
 * globalSetup spawns the MoltZap standalone server once per suite (~12–15 s
 * cold boot). testTimeout is set to 30 s per test to accommodate the
 * server's async admission pipeline (admitAgentsAsync daemon fiber).
 * fileParallelism is false: all test files share one server process and one
 * PGlite DB; parallel file workers could produce interleaved agent names and
 * race on the shared DB.
 *
 * Run with: bunx vitest run --config test/integration/vitest.integration.config.ts
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/integration/**/*.integration.test.ts"],
    globalSetup: ["test/integration/globalSetup.ts"],
    testTimeout: 30_000,
    hookTimeout: 35_000,
    fileParallelism: false,
  },
});
