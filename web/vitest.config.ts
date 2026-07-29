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
    // Playwright specs are excluded by FILENAME rather than by directory (F4).
    // The e2e directory is no longer wholly off-limits to vitest: the shared
    // support modules under `e2e/support/` carry the frozen surface matrix, the
    // owner selector and the pure half of the runtime scanners, and those are
    // ordinary node code whose focused unit tests belong beside them. Every
    // browser suite is a `*.spec.ts`, so the two never collide.
    exclude: ["node_modules/**", ".next/**", "e2e/**/*.spec.ts"],
  },
});
