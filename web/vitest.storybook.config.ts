// Story interaction tests (bead w0e): every story renders in real Chromium and its
// play function runs as a test. Kept out of `pnpm test` the same way the eval suite is.
//
// A SEPARATE config, not a `test.projects` entry (user ruling, bead w0e.2): Vitest resolves
// every project's Vite config in its one main process, and @storybook/nextjs-vite loads
// next.config there, writing NODE_ENV=development and `__NEXT_*` vars that unit workers
// inherit. `vitest.config.ts` never loads it; `vitest-env.test.ts` guards that.
import { fileURLToPath } from "node:url";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    storybookTest({
      configDir: fileURLToPath(new URL("./.storybook", import.meta.url)),
      storybookScript: "pnpm storybook --no-open",
    }),
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
});
