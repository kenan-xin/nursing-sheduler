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
  // Browser suites are `*.spec.ts`, full stop (F4). Playwright's default
  // `testMatch` also claims `*.test.ts`, which would sweep up the vitest unit
  // tests that now sit beside the shared support modules in `e2e/support/` and
  // fail them for calling `describe()` outside a Playwright runner.
  testMatch: /\.spec\.ts$/,
  // The two assembled Browser→Next→FastAPI specs require the live direct Compose
  // stack (no route interception, real backend): `optimize-assembled-stream`
  // (the run protocol) and `roster-real-ward-assembled` (the G5 real Ward 8
  // roster journey). Exclude both from the base suite — they run only under
  // `playwright.assembled.config.ts` via `make verify-stream`. The base config's
  // webServer has no FastAPI behind it, so a swept-up assembled spec would fail
  // for the wrong reason.
  // The public-roster-dispatch spec requires a stub backend on a private port
  // (8765), so it runs only under `playwright.public-roster-dispatch.config.ts`
  // — the base config's webServer points BACKEND_API_URL at 127.0.0.1:8000,
  // where a developer's real FastAPI may already be bound.
  testIgnore:
    /optimize-assembled-stream\.spec\.ts|roster-real-ward-assembled\.spec\.ts|optimize-public-roster-dispatch\.spec\.ts/,
  fullyParallel: true,
  workers,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    // NO BFCache launch flags here, deliberately.
    //
    // `e2e/scenario-ownership.spec.ts` drives a real back/forward navigation journey,
    // and forcing `--enable-features=BackForwardCache` was tried: it did NOT produce a
    // restore, because this app holds an IndexedDB connection and a BroadcastChannel
    // open for each page's whole lifetime and both are documented Chromium eligibility
    // blockers. Overriding `--disable-features` wholesale also replaced Playwright's
    // own list and broke the unrelated middle-click/new-tab case. The spec asserts the
    // durable outcome on either path and reports which one ran, so the evidence stands
    // without changing how the browser is launched.
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // F4's coarse-pointer lane. Scoped by `testMatch` to the ONE spec that
    // measures real touch targets, so it adds a single extra run rather than
    // doubling the whole legacy suite. `hasTouch` is what actually flips the
    // pointer media query — the spec asserts `(pointer: coarse)` and
    // `navigator.maxTouchPoints` BEFORE measuring anything, because a context
    // that silently stayed fine-pointer would measure the 32/36px sizes and
    // "pass" for exactly the wrong reason.
    {
      name: "v2-touch",
      testMatch: /v2-visual-system\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        hasTouch: true,
      },
    },
  ],
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
      // COMPILES IN the read-only store bridge (`components/shell/test-bridge.tsx`).
      // An ordinary `pnpm build` leaves this unset, so the bridge is dead code there
      // and no runtime flag can resurrect it; the suite still opts in per page via
      // `addInitScript`, so both the build and the page must agree.
      NEXT_PUBLIC_NS_TEST_BRIDGE: "1",
    },
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
});
