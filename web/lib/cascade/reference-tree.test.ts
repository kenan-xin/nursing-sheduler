import { describe, expect, it } from "vitest";
import {
  filterRefTree,
  isEmptyRefField,
  mapRefTree,
  pruneRefTree,
  refKey,
  renameRefTree,
  sameRef,
} from "./reference-tree";

describe("reference-tree helpers", () => {
  it('matches references by EXACT identity — numeric 3 and string "3" are distinct', () => {
    expect(sameRef(3, "3")).toBe(false); // producer-distinct ids never collapse
    expect(sameRef(3, 3)).toBe(true);
    expect(sameRef("N", "N")).toBe(true);
    expect(sameRef("N", "D")).toBe(false);
    expect(refKey(3)).toBe("3"); // string form is for reserved-keyword/display only
  });

  it("maps every leaf of a nested tree, preserving structure", () => {
    expect(mapRefTree([["A", "B"], "C"], (id) => id.toString().toLowerCase())).toEqual([
      ["a", "b"],
      "c",
    ]);
  });

  it("renames only matching leaves", () => {
    expect(renameRefTree([["A", "B"], "A"], "A", "Z")).toEqual([["Z", "B"], "Z"]);
    expect(renameRefTree("A", "A", "Z")).toBe("Z");
  });

  it("drops filtered leaves and collapses emptied sub-arrays (AC-RI-10)", () => {
    // Deleting A and B empties the inner array, which is then dropped.
    expect(pruneRefTree([["A", "B"], ["C"]], new Set(["A", "B"]))).toEqual([["C"]]);
    // A scalar leaf that fails the filter collapses to [] (length 0).
    expect(filterRefTree("N", (id) => id !== "N")).toEqual([]);
  });

  it("treats present-but-empty as empty, absent/scalar as non-empty", () => {
    expect(isEmptyRefField([])).toBe(true);
    expect(isEmptyRefField(undefined)).toBe(false);
    expect(isEmptyRefField("N")).toBe(false);
    expect(isEmptyRefField(["N"])).toBe(false);
  });
});
