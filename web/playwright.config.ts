import { cpus } from "node:os";
import { defineConfig, devices } from "@playwright/test";
import { resolveWorkerCount, WORKERS_ENV } from "./playwright.workers";

// Defaults to 3100; override via PLAYWRIGHT_PORT so isolated worktrees can run
// the e2e suite concurrently without colliding on the host port.
const PORT = Number(process.env.PLAYWRIGHT_PORT) || 3100;
const baseURL = `http://127.0.0.1:${PORT}`;

// Deterministic worker count (qq0.29). Playwright's built-in default scales
// UNBOUNDED with the host (ceil(cpus/2)); on a large runner that spawns 30+
// workers and the suite fails under CPU starvation while passing on a laptop.
// `resolveWorkerCount` bounds it so the required release gate is reproducible;
// `PLAYWRIGHT_WORKERS` (and the `--workers` CLI flag) still override it for the
// explicit high-parallelism stress lane.
const workers = resolveWorkerCount({
  cpuCount: cpus().length,
  override: process.env[WORKERS_ENV],
});

// E2E smoke runs against a production build of the empty app. `webServer` builds
// and starts Next, then the smoke spec asserts the shell renders.
export default defineConfig({
  testDir: "./e2e",
  // The assembled Browser→Next→FastAPI spec requires the live direct Compose
  // stack (no route interception, real backend). Exclude it from the base
  // suite — it runs only under `playwright.assembled.config.ts` via
  // `make verify-stream`.
  testIgnore: /optimize-assembled-stream\.spec\.ts/,
  fullyParallel: true,
  workers,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Build, then serve the standalone artifact via `pnpm start` (which prepares
    // static/public and runs the standalone server — `next start` is unsupported
    // with output:'standalone').
    command: "pnpm build && pnpm start",
    url: baseURL,
    // BACKEND_API_URL + PUBLIC_ORIGIN are required at startup in production
    // (T06's instrumentation fail-fast). The design-system specs don't call the
    // backend, so a localhost placeholder satisfies the config gate without a
    // live backend.
    env: {
      PORT: String(PORT),
      HOSTNAME: "127.0.0.1",
      NEXT_PUBLIC_APP_VERSION: "0.1.0",
      BACKEND_API_URL: "http://127.0.0.1:8000",
      PUBLIC_ORIGIN: baseURL,
      // Exposes the dev-only `/progress-chart-fixture` harness (gated off in a
      // normal production deploy) so the T16d chart e2e coverage can drive it.
      NS_ENABLE_DEV_FIXTURES: "1",
    },
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
});
