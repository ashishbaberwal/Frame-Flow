import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Suites share one remote Postgres; run them sequentially to avoid
    // concurrent seeding of the same workspace rows.
    fileParallelism: false,
    testTimeout: 20_000,
    // beforeEach seeds workspaces/users/events over HTTP plus sharp mock
    // setup; the first suite also pays the cold-start cost. 30s keeps slow
    // CI agents green without loosening per-test assertions.
    hookTimeout: 30_000,
  },
});
