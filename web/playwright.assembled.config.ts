import { defineConfig, devices } from "@playwright/test";

// T16f assembled-release-gate-only config. Unlike the base `playwright.config.ts`
// (which builds and serves Next via `webServer`), this config has NO webServer:
// the assembled direct Compose stack (brought up by `make verify-stream`)
// provides the real Browser → Next BFF → FastAPI topology on a published host
// port. Passing `ASSEMBLED_BASE_URL=http://localhost:<port>` points every test
// at the live Compose web service, so the spec drives the genuine controller
// through the real BFF with zero route interception.
//
// Only `optimize-assembled-stream.spec.ts` matches; the fixture-based suite
// keeps using the base config (which builds its own Next and stubs `/api/**`).
// Workers is fixed at 1 — the assembled gate is serialized against the single
// backend solver worker.

const baseURL = process.env.ASSEMBLED_BASE_URL ?? "http://127.0.0.1:3000";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /optimize-assembled-stream\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
