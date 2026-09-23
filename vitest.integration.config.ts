import { defineConfig } from "vitest/config";
import { sharedAlias } from "./vitest.shared";

/**
 * `test:integration` (LOCAL DEV ONLY — never run in CI/CD, see `vitest.config.ts`'s own header): the
 * real `screenwriter_api` spawned as a child process against a real Postgres `screenwriter_test`
 * database. Needs `../screenwriter_api` checked out as a sibling and a local Postgres running
 * (`DATABASE_URL=postgres://localhost:5432/screenwriter_test`).
 */
export default defineConfig({
  resolve: { alias: sharedAlias },
  test: {
    environment: "node",
    fileParallelism: false, // integration tests share one spawned API and test DB
    testTimeout: 30_000,
    hookTimeout: 60_000,
    include: ["tests/*.integration.test.ts"],
  },
});
