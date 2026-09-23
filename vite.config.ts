import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// import.meta.url (not __dirname): works under both Vite's legacy and "native" ESM config loaders.
const r = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

/**
 * Bundled library build (Rollup, via Vite's library mode): a single `dist/index.js` — `src/react/`
 * has one JSX file (`context.tsx`), hence `@vitejs/plugin-react`. Declarations are generated
 * separately by `tsconfig.build.json`'s own `tsc --emitDeclarationOnly` pass (see `package.json`'s
 * `build` script).
 */
export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: r("src/index.ts"),
      formats: ["es"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      // Real npm dependencies (peer or direct), never bundled into this package's own output.
      // `yjs` in particular MUST stay external: bundling it would create a second Yjs instance,
      // breaking Y.Doc interop with every other consumer of the same document.
      external: [
        "react",
        "react-dom",
        "zustand",
        "@tanstack/react-query",
        "@sudobility/screenwriter_client",
        "@sudobility/screenwriter_types",
        "@sudobility/writing_core",
        "yjs",
      ],
    },
    sourcemap: true,
    minify: false,
  },
});
