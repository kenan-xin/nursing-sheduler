import { describe, expect, it } from "vitest";
import {
  ALL_NAV_ITEMS,
  GUIDED_STEP_COUNT,
  findNavItem,
  getNavGroupsForMode,
  getNavItemForMode,
} from "./nav-config";
import { isRouteValidForMode } from "./route-registry";

// T08d repair (P2): the fresh review found `isRouteValidForMode` and the
// top-bar crumb re-deriving the Guided/Advanced `advancedOnly` policy
// independently of `getNavGroupsForMode` instead of asking it. This suite
// proves the single shared projection (`getNavItemForMode`) agrees with
// `getNavGroupsForMode` itself and with `isRouteValidForMode`, for every
// registered route in both modes — not just the routes other specs happen to
// click through.
//
// G4 — the closure added `/roster` (an Output destination reachable in BOTH
// modes, with no `guidedStep`). The dedicated assertions below pin the
// discoverability contract (mode + step count) so a future drift fails here
// rather than as an off-by-one somewhere downstream.
describe("nav-config — one filtered registry drives every mode-aware consumer", () => {
  const modes = ["guided", "advanced"] as const;

  it("getNavItemForMode returns exactly the item getNavGroupsForMode itself lists, for every route and mode", () => {
    for (const mode of modes) {
      const visiblePaths = new Set(
        getNavGroupsForMode(mode)
          .flatMap((group) => group.items)
          .map((item) => item.path),
      );
      for (const item of ALL_NAV_ITEMS) {
        const looked = getNavItemForMode(item.path, mode);
        if (visiblePaths.has(item.path)) {
          expect(looked).toBe(item);
        } else {
          expect(looked).toBeUndefined();
        }
      }
    }
  });

  it("a route is hidden from Guided if and only if it is advancedOnly", () => {
    for (const item of ALL_NAV_ITEMS) {
      const visibleInGuided = getNavItemForMode(item.path, "guided") != null;
      expect(visibleInGuided).toBe(!item.advancedOnly);
    }
  });

  it("every registered route is visible in Advanced", () => {
    for (const item of ALL_NAV_ITEMS) {
      expect(getNavItemForMode(item.path, "advanced")).toBe(item);
    }
  });

  it("isRouteValidForMode agrees with getNavItemForMode for every registered route and mode", () => {
    for (const mode of modes) {
      for (const item of ALL_NAV_ITEMS) {
        expect(isRouteValidForMode(item.path, mode)).toBe(
          getNavItemForMode(item.path, mode) != null,
        );
      }
    }
  });

  it("an unlisted route carries no mode policy and is always valid", () => {
    expect(findNavItem("/design-system")).toBeUndefined();
    expect(isRouteValidForMode("/design-system", "guided")).toBe(true);
    expect(isRouteValidForMode("/design-system", "advanced")).toBe(true);
    expect(getNavItemForMode("/design-system", "guided")).toBeUndefined();
  });
});

describe("nav-config — G4 Roster discoverability contract", () => {
  // G4 closure — the dedicated `/roster` route was added to the shared Output
  // group immediately after `Optimise & Export`, with the prototype calendar
  // check icon and the prototype-aligned blurb. These assertions are the unit
  // half of the discoverability contract; the e2e half is in app-shell.spec
  // and mode-aware-shell.spec.

  const roster = findNavItem("/roster");

  it("registers a /roster entry in the shared registry", () => {
    expect(roster).toBeDefined();
    expect(roster?.label).toBe("Roster");
    expect(roster?.path).toBe("/roster");
    expect(roster?.blurb).toBe("View & manually adjust results");
  });

  it("/roster sits in the Output group, immediately after Optimise & Export", () => {
    const outputItems =
      getNavGroupsForMode("advanced").find((group) => group.id === "output")?.items ?? [];
    expect(outputItems.map((item) => item.path)).toEqual(["/optimize-and-export", "/roster"]);
  });

  it("/roster is reachable from both Guided and Advanced", () => {
    expect(getNavItemForMode("/roster", "guided")).toBeDefined();
    expect(getNavItemForMode("/roster", "advanced")).toBeDefined();
    expect(isRouteValidForMode("/roster", "guided")).toBe(true);
    expect(isRouteValidForMode("/roster", "advanced")).toBe(true);
  });

  it("/roster carries no guidedStep, so GUIDED_STEP_COUNT stays at six", () => {
    expect(roster?.guidedStep).toBeUndefined();
    expect(GUIDED_STEP_COUNT).toBe(6);
  });
});
