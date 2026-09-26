// qq0.14.1 — which Advanced-only editor a Guided redirect just left, so the
// destination (Guided Rules) can name it and point at its rules. In memory, not
// in the URL: Next 16.2's client route cache replays the first `?search` or
// `#hash` it saw for a static route, so `/rules?from=b` lands on `?from=a`.
// One-shot: the destination takes it once, so a later ordinary visit shows
// nothing stale.
// ponytail: only Rules consumes it, which holds while every `guidedDestination`
// is Rules; a destination elsewhere (Export Layout → Optimise) must consume or
// clear it too, or Rules would show a stale note on its next visit.

import { create } from "zustand";
import { navRouteIdForPath, type NavRouteId } from "./nav-config";

const useGuidedArrivalStore = create<{ from: NavRouteId | null }>(() => ({ from: null }));

/** Record `path` as the route a Guided redirect is leaving. */
export function noteGuidedArrival(path: string): void {
  useGuidedArrivalStore.setState({ from: navRouteIdForPath(path) ?? null });
}

/** Read the pending arrival without consuming it (pure; safe in render). */
export function peekGuidedArrival(): NavRouteId | null {
  return useGuidedArrivalStore.getState().from;
}

export function clearGuidedArrival(): void {
  useGuidedArrivalStore.setState({ from: null });
}
