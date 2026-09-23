import { describe, expect, it } from "vitest";
import {
  ALL_NAV_ITEMS,
  findNavItemById,
  isRouteIdVisibleInMode,
  NAV_ROUTE_IDS,
  navRouteIdForPath,
  type NavRouteId,
} from "./nav-config";

// T06: the stable route ids are the capability registry's only handle on a screen,
// so the invariant that matters is a BIJECTION between the id tuple and the shipped
// navigation entries. An id in the tuple with no entry makes `findNavItemById` throw
// at runtime; an entry with an id outside the tuple cannot be referenced by the
// registry at all. Neither is visible from the existing nav-config suite, which is
// about mode filtering.
describe("nav-config — stable route ids", () => {
  it("every declared id is registered exactly once", () => {
    for (const id of NAV_ROUTE_IDS) {
      const matches = ALL_NAV_ITEMS.filter((item) => item.id === id);
      expect(matches, `route id "${id}"`).toHaveLength(1);
    }
  });

  it("every registered entry declares an id from the tuple, and no two share one", () => {
    const declared = new Set<string>(NAV_ROUTE_IDS);
    const seen = new Set<string>();
    for (const item of ALL_NAV_ITEMS) {
      expect(declared.has(item.id), `"${item.path}" declares unknown id "${item.id}"`).toBe(true);
      expect(seen.has(item.id), `id "${item.id}" is used twice`).toBe(false);
      seen.add(item.id);
    }
    expect(seen.size).toBe(NAV_ROUTE_IDS.length);
  });

  it("paths are unique, so id↔path is a bijection in both directions", () => {
    const paths = ALL_NAV_ITEMS.map((item) => item.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const item of ALL_NAV_ITEMS) {
      expect(navRouteIdForPath(item.path)).toBe(item.id);
      expect(findNavItemById(item.id).path).toBe(item.path);
    }
  });

  it("findNavItemById throws rather than returning undefined for an unknown id", () => {
    // The registry's callers are written without an "it might not exist" branch, so a
    // broken invariant has to be loud rather than silently target-less.
    expect(() => findNavItemById("not-a-route" as NavRouteId)).toThrow(/no navigation entry/);
  });

  it("isRouteIdVisibleInMode agrees with the mode-filtered projection", () => {
    for (const item of ALL_NAV_ITEMS) {
      expect(isRouteIdVisibleInMode(item.id, "advanced")).toBe(true);
      expect(isRouteIdVisibleInMode(item.id, "guided")).toBe(!item.advancedOnly);
    }
  });

  it("an unlisted route has no stable id", () => {
    expect(navRouteIdForPath("/design-system")).toBeUndefined();
  });
});
