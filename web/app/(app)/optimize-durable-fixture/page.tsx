// T16f — production gate for the durable Optimize & Export ACCEPTANCE harness.
//
// Unlike `/optimize-screen-fixture` (pure presentational states, no controller or
// transport), this page mounts the REAL `<OptimizeAndExportScreen>` with its real
// run controller, session-transaction storage, SSE/poll transport, terminal
// download/cleanup orchestration, recovery, and server-identity — everything the
// durable run protocol touches. The ONLY seam it injects is `prepare`: the
// client-side scenario→strict-YAML serialization (already covered exhaustively by
// the T16q `prepareOptimizeSubmission` unit tests) is replaced with a canned prep
// so the assembled Browser journey does not depend on hand-seeding a fully valid
// canonical scenario. The deterministic browser matrix stubs the HTTP boundary
// with `page.route`, while the assembled Compose spec leaves it untouched and
// drives the real Browser → Next → FastAPI path. Both modes exercise the genuine
// controller + reducer + SSE parser + reconnect + terminal + cleanup pipeline. It
// is gated behind `NS_ENABLE_DEV_FIXTURES` (404 in a normal production deploy)
// exactly like the other browser fixtures.

import { notFound } from "next/navigation";
import OptimizeDurableFixtureClient from "./fixture-client";

export const dynamic = "force-dynamic";

function devFixturesEnabled(): boolean {
  const flag = process.env.NS_ENABLE_DEV_FIXTURES;
  return flag === "1" || flag === "true";
}

export default function OptimizeDurableFixturePage() {
  if (!devFixturesEnabled()) {
    notFound();
  }
  return <OptimizeDurableFixtureClient />;
}
