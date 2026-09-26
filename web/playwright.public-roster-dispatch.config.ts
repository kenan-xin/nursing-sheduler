import { defineConfig, devices } from "@playwright/test";
import { webServerCommand } from "./playwright.config";

// Focused config for the B3 nested fixup `public-next-dispatch-fix`. Reuses the
// base config's `pnpm build && pnpm start` webServer (the SAME production
// standalone Next launcher the assembled gate uses — not a parallel one) and
// only overrides `BACKEND_API_URL` so the spec can bind a private port for its
// stub backend without colliding with a developer's real FastAPI on
// 127.0.0.1:8000. `testMatch` restricts execution to just the public-dispatch
// spec; the full e2e suite keeps running under `playwright.config.ts`.
//
// Run with: `pnpm exec playwright test --config=playwright.public-roster-dispatch.config.ts`
// (or `make`-wrapped equivalent).

const PORT = Number(process.env.PLAYWRIGHT_PORT) || 3101;
const baseURL = `http://127.0.0.1:${PORT}`;
// Private port for the spec's stub backend — chosen outside the registered
// services range to avoid colliding with a developer's local backend on 8000.
const BACKEND_PORT = Number(process.env.PUBLIC_ROSTER_TEST_BACKEND_PORT) || 8765;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /optimize-public-roster-dispatch\.spec\.ts$/,
  fullyParallel: false,
  // One backend stub, one Next server, one worker — no race for BACKEND_PORT.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Same launcher as the base config: build standalone, then run it — or, in
    // CI (PW_PREBUILT), start the build shipped by the `e2e-build` job.
    command: webServerCommand,
    url: baseURL,
    env: {
      PORT: String(PORT),
      HOSTNAME: "127.0.0.1",
      NEXT_PUBLIC_APP_VERSION: "0.1.0",
      // The Next BFF reaches the spec's stub backend here (NOT a real FastAPI).
      BACKEND_API_URL: `http://127.0.0.1:${BACKEND_PORT}`,
      PUBLIC_ORIGIN: baseURL,
      NS_ENABLE_DEV_FIXTURES: "1",
      // Same as the base config: compiles the read-only store bridge in for the
      // browser suite only. An ordinary production build leaves it out entirely.
      NEXT_PUBLIC_NS_TEST_BRIDGE: "1",
    },
    timeout: 120_000,
    // Never attach to an already-running server, so a stale one (without the
    // roster route) cannot false-green the dispatch proof. The build itself is
    // fresh: local runs rebuild, CI starts this run's own `e2e-build` output.
    reuseExistingServer: false,
  },
});
