import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Integration tests live at test/integration/*.integration.test.ts and
    // need the subprocess `globalSetup` declared in
    // `test/integration/vitest.integration.config.ts`. They are invoked
    // separately (`bun x vitest --config test/integration/vitest.integration.config.ts`)
    // so the unit-test run stays fast + hermetic.
    exclude: [
      "node_modules/**",
      "dist/**",
      "vendor/**",
      "test/integration/**",
    ],
    root: __dirname,
  },
});
