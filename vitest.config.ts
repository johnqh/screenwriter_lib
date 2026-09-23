import { defineConfig } from "vitest/config";
import { sharedAlias } from "./vitest.shared";

/**
 * `test:unit` (what CI/CD runs): hermetic tests only — no DB, no spawned server, no live network
 * endpoint. `*.integration.test.ts` (`bun run test:integration`) spawn the real `screenwriter_api`
 * and a real Postgres `screenwriter_test` database; they are LOCAL-DEV-ONLY (need the sibling
 * `screenwriter_api` repo checked out and Postgres running) and must never run here.
 */
export default defineConfig({
  resolve: { alias: sharedAlias },
  test: {
    environment: "node", // hooks.test.tsx overrides per-file with `// @vitest-environment happy-dom`
    testTimeout: 30_000,
    include: ["tests/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"],
  },
});
