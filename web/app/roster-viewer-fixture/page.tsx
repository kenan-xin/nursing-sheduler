// F4 — production gate for the roster viewer BROWSER fixture.
//
// Unlike `/optimize-screen-fixture`, which renders pure presentational states,
// this fixture drives PRODUCTION storage: real `rosterStorage`, a real committed
// candidate carrying a genuine `Blob`, the real F1 promotion path, and the real
// app-lifetime F2 capture gate. That is the point — the jsdom suite cannot clone
// a Blob through fake-indexeddb and has no layout engine, so the durable Load
// path and the container-width/sticky geometry can only be proven here.
//
// Gated behind `NS_ENABLE_DEV_FIXTURES` like the other fixtures, so a normal
// production deploy returns 404 while Playwright (which serves a real production
// build) can drive it.

import { notFound } from "next/navigation";
import RosterViewerFixtureClient from "./fixture-client";

export const dynamic = "force-dynamic";

function devFixturesEnabled(): boolean {
  const flag = process.env.NS_ENABLE_DEV_FIXTURES;
  return flag === "1" || flag === "true";
}

export default function RosterViewerFixturePage() {
  if (!devFixturesEnabled()) {
    notFound();
  }
  return <RosterViewerFixtureClient />;
}
