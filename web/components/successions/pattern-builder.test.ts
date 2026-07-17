import { describe, expect, it } from "vitest";
import {
  appendPatternEntry,
  movePatternEntryEarlier,
  movePatternEntryLater,
  removePatternEntry,
  reorderPatternByDrop,
} from "./pattern-builder";

describe("appendPatternEntry (spec 05 FR-PR-32, EDGE-PR-08)", () => {
  it("appends to the end, order-preserving", () => {
    expect(appendPatternEntry([], "N")).toEqual(["N"]);
    expect(appendPatternEntry(["N"], "AM")).toEqual(["N", "AM"]);
  });

  it("allows duplicates — a repeated id is appended again, not toggled off", () => {
    expect(appendPatternEntry(["N", "AM"], "N")).toEqual(["N", "AM", "N"]);
  });
});

describe("movePatternEntryEarlier / movePatternEntryLater", () => {
  it("swaps adjacent positions", () => {
    expect(movePatternEntryEarlier(["N", "AM", "PM"], 1)).toEqual(["AM", "N", "PM"]);
    expect(movePatternEntryLater(["N", "AM", "PM"], 1)).toEqual(["N", "PM", "AM"]);
  });

  it("is a no-op at the pattern's ends (defensive floor)", () => {
    expect(movePatternEntryEarlier(["N", "AM"], 0)).toEqual(["N", "AM"]);
    expect(movePatternEntryLater(["N", "AM"], 1)).toEqual(["N", "AM"]);
  });

  it("moves the correct entry through a duplicate-bearing sequence", () => {
    // ["N", "AM", "N"] — move the LAST "N" (index 2) earlier past "AM".
    expect(movePatternEntryEarlier(["N", "AM", "N"], 2)).toEqual(["N", "N", "AM"]);
  });
});

describe("removePatternEntry", () => {
  it("removes exactly the entry at the given index, leaving duplicates elsewhere intact", () => {
    expect(removePatternEntry(["N", "AM", "N"], 0)).toEqual(["AM", "N"]);
    expect(removePatternEntry(["N", "AM", "N"], 2)).toEqual(["N", "AM"]);
  });

  it("returns a fresh array (no aliasing) even on an out-of-range index", () => {
    const source = ["N", "AM"];
    const result = removePatternEntry(source, 5);
    expect(result).toEqual(source);
    expect(result).not.toBe(source);
  });
});

describe("reorderPatternByDrop (FR-PR-33 — drag reorder of pattern positions)", () => {
  it("inserts BEFORE the target on a left-half drop", () => {
    expect(reorderPatternByDrop(["N", "AM", "PM"], 0, 2, "before")).toEqual(["AM", "N", "PM"]);
  });

  it("inserts AFTER the target on a right-half drop", () => {
    expect(reorderPatternByDrop(["N", "AM", "PM"], 0, 2, "after")).toEqual(["AM", "PM", "N"]);
  });

  it("moves a later entry toward the front", () => {
    expect(reorderPatternByDrop(["N", "AM", "PM"], 2, 0, "before")).toEqual(["PM", "N", "AM"]);
  });

  it("is a no-op (fresh copy) when source and target are the same, or out of range", () => {
    const source = ["N", "AM"];
    expect(reorderPatternByDrop(source, 1, 1, "before")).toEqual(["N", "AM"]);
    const oob = reorderPatternByDrop(source, 0, 5, "after");
    expect(oob).toEqual(source);
    expect(oob).not.toBe(source);
  });

  it("preserves duplicates while reordering (order-significant, duplicate-allowing)", () => {
    // ["N", "AM", "N"] — drag the first N (index 0) to after the last N (index 2).
    expect(reorderPatternByDrop(["N", "AM", "N"], 0, 2, "after")).toEqual(["AM", "N", "N"]);
  });
});
