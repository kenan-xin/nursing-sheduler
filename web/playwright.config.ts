import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
const baseURL = `http://127.0.0.1:${PORT}`;

// E2E smoke runs against a production build of the empty app. `webServer` builds
// and starts Next, then the smoke spec asserts the shell renders.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
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
    },
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
});
