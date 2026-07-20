// T16e — production gate for the Optimize & Export screen TEST FIXTURE.
//
// A deterministic browser harness for the screen's presentational states
// (responsive / a11y / dark-mode / token / recovery / control / terminal coverage),
// NOT a shipped screen. Like the T16d chart fixture it is gated behind
// `NS_ENABLE_DEV_FIXTURES` so a normal production deploy returns 404, while
// Playwright (which serves a real production build) can drive it. It renders only
// the pure presentational components in fixed states — no controller, transport,
// or direct-stream — so it makes no direct-stream (T16f) claim.

import { notFound } from "next/navigation";
import OptimizeScreenFixtureClient from "./fixture-client";

export const dynamic = "force-dynamic";

function devFixturesEnabled(): boolean {
  const flag = process.env.NS_ENABLE_DEV_FIXTURES;
  return flag === "1" || flag === "true";
}

export default function OptimizeScreenFixturePage() {
  if (!devFixturesEnabled()) {
    notFound();
  }
  return <OptimizeScreenFixtureClient />;
}
