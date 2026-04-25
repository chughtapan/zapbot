import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/integration/**/*.integration.test.ts"],
    root: __dirname,
  },
});
