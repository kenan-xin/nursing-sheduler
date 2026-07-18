import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Mirror the tsconfig `@/*` path alias for test imports.
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    // Node environment is enough for the plain `.ts` unit suite. `.tsx` component
    // tests opt into jsdom per-file via a `// @vitest-environment jsdom` docblock
    // (vitest 4 dropped the workspace-level `environmentMatchGlobs` option), so
    // the existing `.ts` tests keep the faster node environment.
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/*.{test,spec}.{ts,tsx}"],
    exclude: ["node_modules", ".next", "e2e"],
  },
});
