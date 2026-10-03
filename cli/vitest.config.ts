import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20000,
    // The fake server and the CLI share one process; keep files isolated.
    pool: "forks",
  },
});
