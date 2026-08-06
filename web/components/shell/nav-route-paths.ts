// The stable route id → path binding (T06). DEPENDENCY-FREE ON PURPOSE.
//
// `nav-config.ts` is the navigation registry, but it imports the icon barrel, which
// pulls React and `react-icons` in with it. Build tooling and the Playwright suite
// need the id↔path binding WITHOUT any of that — a route-level fixture that has to
// import React to learn a URL is a fixture that will eventually break on module
// interop rather than on a real defect.
//
// This is the single authority: `nav-config.ts` builds each entry's `path` from the
// map below rather than restating it, so a renamed route is one edit here and the two
// can never disagree. `NavRouteId` is `keyof` this map, which is what makes a
// capability entry naming a screen the app does not ship a compile error.

export const NAV_ROUTE_PATHS = {
  home: "/",
  dates: "/dates",
  people: "/people",
  "shift-types": "/shift-types",
  rules: "/rules",
  "shift-requests": "/shift-requests",
  "shift-type-requirements": "/shift-type-requirements",
  "shift-type-successions": "/shift-type-successions",
  "shift-counts": "/shift-counts",
  "shift-affinities": "/shift-affinities",
  "shift-type-coverings": "/shift-type-coverings",
  "optimize-and-export": "/optimize-and-export",
  "save-and-load": "/save-and-load",
  settings: "/settings",
} as const;

export type NavRouteId = keyof typeof NAV_ROUTE_PATHS;

export const NAV_ROUTE_IDS = Object.freeze(Object.keys(NAV_ROUTE_PATHS)) as readonly NavRouteId[];

/** The path for a stable route id. Total over `NavRouteId`, so no caller branches. */
export function navRoutePath(id: NavRouteId): string {
  return NAV_ROUTE_PATHS[id];
}
