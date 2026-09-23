// Confirming that a client route transition actually ARRIVED (T06 / C2F2).
//
// `router.push` in the App Router STARTS a client transition and returns. The URL
// commits when the transition commits, which is after the router has fetched whatever
// the destination needs. So the pathname read on the line after the push is the screen
// the user is LEAVING -- the normal state, not a failure -- and treating it as the
// outcome refuses every genuine cross-route jump while it is merely still in flight.
//
// BOUNDED, LIKE THE ANCHOR WAIT NEXT DOOR. "We could not confirm you got there" is a
// legitimate reportable outcome; a help answer that never returns is not. The wait
// polls rather than subscribing to the router, for the same reason `live-anchor.ts`
// polls: a subscription that never fires waits forever, and the deadline is the whole
// point.
//
// ARRIVAL IS EXACT. A redirect, a guarded route that bounces, and a transition that
// simply never commits are all one answer here -- not this screen -- because the only
// thing this module is entitled to claim is whether the user is on the exact path that
// was asked for. A near miss is a miss.

export type RouteArrival =
  | { readonly status: "arrived" }
  /** Where we ended up instead, for the caller's log. Never for the user's answer. */
  | { readonly status: "not_reached"; readonly pathname: string };

/** Just the live pathname. Narrow on purpose so tests need no `window`. */
export interface RouteLocation {
  readonly pathname: string;
}

/**
 * The comparable form of a path.
 *
 * A query string or fragment is not part of the screen's identity, and a trailing
 * slash is the same screen written differently. Everything else is significant: this
 * normalises spelling, it does not loosen the match.
 */
export function normalizeRoutePath(pathname: string): string {
  const path = pathname.split(/[?#]/, 1)[0] ?? "";
  if (path === "") return "/";
  if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
  return path;
}

/** Whether the live location is the exact screen `path` names. */
export function isAtRoutePath(location: RouteLocation, path: string): boolean {
  return normalizeRoutePath(location.pathname) === normalizeRoutePath(path);
}

export interface WaitForRouteArrivalOptions {
  /** Give up after this long. A hung wait is a hung help answer. */
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}

/**
 * Poll the live location until it is exactly `path`, or the budget runs out.
 *
 * `location` is read on every pass rather than captured, so `window.location` -- whose
 * `pathname` is a live getter -- is the intended argument.
 */
export async function waitForRouteArrival(
  location: RouteLocation,
  path: string,
  options: WaitForRouteArrivalOptions = {},
): Promise<RouteArrival> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const intervalMs = options.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;

  // Checked before the first sleep: when the caller is already on the screen there is
  // nothing in flight, and one interval of dead latency on every such call is latency
  // spent proving something already true.
  while (!isAtRoutePath(location, path)) {
    if (Date.now() >= deadline) {
      return { status: "not_reached", pathname: normalizeRoutePath(location.pathname) };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { status: "arrived" };
}
