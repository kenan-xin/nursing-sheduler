import { describe, expect, it } from "vitest";
import { ALL_NAV_ITEMS, findNavItem, getNavGroupsForMode, getNavItemForMode } from "./nav-config";
import { isRouteValidForMode } from "./route-registry";

// T08d repair (P2): the fresh review found `isRouteValidForMode` and the
// top-bar crumb re-deriving the Guided/Advanced `advancedOnly` policy
// independently of `getNavGroupsForMode` instead of asking it. This suite
// proves the single shared projection (`getNavItemForMode`) agrees with
// `getNavGroupsForMode` itself and with `isRouteValidForMode`, for every
// registered route in both modes — not just the routes other specs happen to
// click through.
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
