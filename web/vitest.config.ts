import { fileURLToPath } from "node:url";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, type Plugin } from "vitest/config";

// Vitest resolves EVERY project's Vite config in its one main process, even under
// `--project unit`, and workers inherit that process's env. `@storybook/nextjs-vite` loads
// next.config while resolving, which writes NODE_ENV=development plus ~70 `__NEXT_*` vars into
// process.env -- and 8 unit tests failed on it. So the storybook project's config phase gets its
// env side effects undone once its config is resolved (its own define/env are captured by then).
// `__STORYBOOK_URL__`/`__STORYBOOK_SCRIPT__` are set when `storybookTest()` is called, before
// the snapshot, so its global setup still sees them. `vitest-env.test.ts` pins the result.
let envBeforeStorybook: Record<string, string | undefined> = {};
const snapshotEnv: Plugin = {
  name: "storybook-env-snapshot",
  enforce: "pre",
  config() {
    envBeforeStorybook = { ...process.env };
  },
};
const restoreEnv: Plugin = {
  name: "storybook-env-restore",
  enforce: "post",
  // `config`, not `configResolved`: under `--project unit` Vitest runs only the storybook
  // project's `config` hooks (to learn its name), and `post` orders this one after them.
  config() {
    for (const key of Object.keys(process.env)) {
      if (!(key in envBeforeStorybook)) delete process.env[key];
    }
    Object.assign(process.env, envBeforeStorybook);
  },
};

// Two projects (bead w0e.2). `pnpm test` pins `--project unit`, so CI's unit shards and every
// existing command keep exactly the suite they had; `pnpm test:stories` runs `--project
// storybook` (every story renders in real Chromium and its play function runs as a test). A
// bare `vitest run` runs BOTH and needs Playwright's Chromium installed.
export default defineConfig({
  resolve: {
    // Mirror the tsconfig `@/*` path alias for test imports.
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
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
          server: {
            deps: {
              // `@copilotkit/react-core/v2` imports its own stylesheet from inside the
              // package (`dist/v2/index.mjs` -> `./index.css`). Externalized, that reaches
              // Node's ESM loader, which cannot load `.css`; inlined, Vite transforms the
              // module and handles the import. Without this the assistant's component
              // suite cannot import the library at all.
              inline: [/@copilotkit\/react-core/],
            },
          },
        },
      },
      {
        extends: true,
        plugins: [
          snapshotEnv,
          storybookTest({
            configDir: fileURLToPath(new URL("./.storybook", import.meta.url)),
            storybookScript: "pnpm storybook --no-open",
          }),
          restoreEnv,
        ],
        test: {
          name: "storybook",
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
