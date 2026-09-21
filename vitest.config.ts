import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  // Vitest does not read tsconfig `paths`; mirror them here (keep in sync with tsconfig.json).
  // yjs/lib0 MUST point at writing_core's copy: one Yjs instance at runtime.
  resolve: {
    alias: [
      { find: /^@sudobility\/screenwriter_client$/, replacement: p("../screenwriter_client/src/index.ts") },
      { find: /^@sudobility\/screenwriter_types$/, replacement: p("../screenwriter_types/src/index.ts") },
      { find: /^@sudobility\/writing_core$/, replacement: p("../writing_core/src/index.ts") },
      { find: /^yjs$/, replacement: p("../writing_core/node_modules/yjs/dist/yjs.mjs") },
      { find: /^lib0\/(.*)$/, replacement: p("../writing_core/node_modules/lib0/") + "$1" },
    ],
  },
  test: {
    environment: "node",
    fileParallelism: false, // integration tests share one spawned API and test DB
    testTimeout: 30_000,
    hookTimeout: 60_000,
    include: ["tests/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
  },
});
