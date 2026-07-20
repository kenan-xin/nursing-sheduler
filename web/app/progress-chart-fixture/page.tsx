// T16d — production gate for the optimization progress chart TEST FIXTURE.
//
// The fixture is a browser test harness (responsive / a11y / dark-mode / density
// coverage), NOT a shipped screen like the intentionally-public `/design-system`
// living style reference. To keep it off the production surface while still
// running deterministically under Playwright — which serves a real production
// build (`pnpm build && pnpm start`) — the route is gated behind an env flag.
//
// `NS_ENABLE_DEV_FIXTURES=1` is set only by `playwright.config.ts`'s webServer
// and can be exported for local dev; a normal production deploy leaves it unset,
// so the route returns 404. `force-dynamic` evaluates the gate per request from
// the runtime environment rather than baking a build-time value.

import { notFound } from "next/navigation";
import ProgressChartFixtureClient from "./fixture-client";

export const dynamic = "force-dynamic";

function devFixturesEnabled(): boolean {
  const flag = process.env.NS_ENABLE_DEV_FIXTURES;
  return flag === "1" || flag === "true";
}

export default function ProgressChartFixturePage() {
  if (!devFixturesEnabled()) {
    notFound();
  }
  return <ProgressChartFixtureClient />;
}
