import { describe, expect, it } from "vitest";
import {
  accumulateDeepestClear,
  computeHistoryApplyPosition,
  computeHistoryClearPosition,
  computeQuickPaintCellIntent,
  markCellVisited,
  prependHistoryEntry,
  resolveHistoryPaintSelection,
  truncateHistoryThroughPosition,
  updateHistoryAtPosition,
  visitedCellKey,
} from "./requests-gestures";

describe("computeQuickPaintCellIntent", () => {
  it("erases the coordinate when no targets are selected", () => {
    expect(computeQuickPaintCellIntent([], null)).toEqual({ mode: "erase" });
    expect(computeQuickPaintCellIntent([], 5)).toEqual({ mode: "erase" });
  });

  it("LEAVE wins over any other selected target", () => {
    expect(computeQuickPaintCellIntent(["LEAVE"], null)).toEqual({
      mode: "day-state",
      dayState: { kind: "leave" },
    });
    expect(computeQuickPaintCellIntent(["AM", "LEAVE", "OFF"], 5)).toEqual({
      mode: "day-state",
      dayState: { kind: "leave" },
    });
  });

  it("returns null when a weight is required but unparsed/invalid", () => {
    expect(computeQuickPaintCellIntent(["OFF"], null)).toBeNull();
    expect(computeQuickPaintCellIntent(["AM"], null)).toBeNull();
  });

  it("a sole OFF selection is a day-state at the given weight", () => {
    expect(computeQuickPaintCellIntent(["OFF"], 5)).toEqual({
      mode: "day-state",
      dayState: { kind: "off", weight: 5 },
    });
    expect(computeQuickPaintCellIntent(["OFF"], 0)).toEqual({
      mode: "day-state",
      dayState: { kind: "off", weight: 0 },
    });
    expect(computeQuickPaintCellIntent(["OFF"], Infinity)).toEqual({
      mode: "day-state",
      dayState: { kind: "off", weight: Infinity },
    });
  });

  it("worked targets produce additive request deltas", () => {
    const intent = computeQuickPaintCellIntent(["AM", "PM"], 5);
    expect(intent).toEqual({
      mode: "requests",
      deltas: new Map([
        ["AM", 5],
        ["PM", 5],
      ]),
    });
  });

  it("OFF mixed with worked targets is dropped (only sole OFF is a day-state)", () => {
    const intent = computeQuickPaintCellIntent(["AM", "OFF"], 5);
    expect(intent).toEqual({ mode: "requests", deltas: new Map([["AM", 5]]) });
  });

  it("weight 0 stages a removal delta (caller's store applies the removal)", () => {
    const intent = computeQuickPaintCellIntent(["AM"], 0);
    expect(intent).toEqual({ mode: "requests", deltas: new Map([["AM", 0]]) });
  });

  it("ALL and group targets are treated as ordinary worked selectors", () => {
    const intent = computeQuickPaintCellIntent(["ALL", "EARLY"], 3);
    expect(intent).toEqual({
      mode: "requests",
      deltas: new Map([
        ["ALL", 3],
        ["EARLY", 3],
      ]),
    });
  });
});

describe("brush visited-once tracking", () => {
  it("keys on cellType:person:identifier", () => {
    expect(visitedCellKey("preference", "kevin", "2026-01-05")).toBe("preference:kevin:2026-01-05");
    expect(visitedCellKey("history", 1, 2)).toBe("history:1:2");
  });

  it("applies a cell the first time it is visited, and never again this gesture", () => {
    const visited = new Set<string>();
    expect(markCellVisited(visited, "preference", "kevin", "d1")).toBe(true);
    expect(markCellVisited(visited, "preference", "kevin", "d1")).toBe(false);
    expect(markCellVisited(visited, "preference", "kevin", "d2")).toBe(true);
    expect(markCellVisited(visited, "history", "kevin", "d1")).toBe(true);
  });
});

describe("resolveHistoryPaintSelection", () => {
  // Worked items + the reserved OFF/LEAVE (parity: the old app's
  // `shiftTypeData.items` includes the AUTO_GENERATED_ITEMS OFF/LEAVE).
  const validItemIds = new Set(["AM", "PM", "N", "OFF", "LEAVE"]);

  it("no selection clears", () => {
    expect(resolveHistoryPaintSelection([], validItemIds)).toEqual({ kind: "clear" });
  });

  it("exactly one worked item sets that value", () => {
    expect(resolveHistoryPaintSelection(["AM"], validItemIds)).toEqual({
      kind: "set",
      shiftType: "AM",
    });
  });

  it("the reserved OFF and LEAVE items are valid history values", () => {
    expect(resolveHistoryPaintSelection(["OFF"], validItemIds)).toEqual({
      kind: "set",
      shiftType: "OFF",
    });
    expect(resolveHistoryPaintSelection(["LEAVE"], validItemIds)).toEqual({
      kind: "set",
      shiftType: "LEAVE",
    });
  });

  it("a group (not in validItemIds) is skipped", () => {
    expect(resolveHistoryPaintSelection(["EARLY"], validItemIds)).toEqual({ kind: "skip" });
  });

  it("multiple selections error verbatim", () => {
    expect(resolveHistoryPaintSelection(["AM", "PM"], validItemIds)).toEqual({
      kind: "error",
      message: "Cannot set history to multiple shift types.",
    });
  });
});

describe("computeHistoryApplyPosition", () => {
  it("appends when the column is left of the real entries", () => {
    // historyCount=4, historyLength=1 -> offset=3; columnIndex 0,1,2 are padding.
    expect(computeHistoryApplyPosition(0, 1, 4)).toEqual({ action: "append" });
    expect(computeHistoryApplyPosition(2, 1, 4)).toEqual({ action: "append" });
  });

  it("updates the real position at/after the offset", () => {
    expect(computeHistoryApplyPosition(3, 1, 4)).toEqual({ action: "update", position: 0 });
    expect(computeHistoryApplyPosition(5, 2, 6)).toEqual({ action: "update", position: 1 });
  });
});

describe("computeHistoryClearPosition", () => {
  it("returns null left of the real entries", () => {
    expect(computeHistoryClearPosition(0, 1, 4)).toBeNull();
  });

  it("returns the real position at/after the offset", () => {
    expect(computeHistoryClearPosition(3, 1, 4)).toBe(0);
    expect(computeHistoryClearPosition(5, 2, 6)).toBe(1);
  });
});

describe("accumulateDeepestClear", () => {
  it("keeps the deepest (Math.max) position per person across a drag", () => {
    const pending = new Map<string, number>();
    accumulateDeepestClear(pending, "kevin", 1);
    accumulateDeepestClear(pending, "kevin", 3);
    accumulateDeepestClear(pending, "kevin", 2);
    expect(pending.get("kevin")).toBe(3);
  });

  it("tracks separate people independently", () => {
    const pending = new Map<string, number>();
    accumulateDeepestClear(pending, "kevin", 1);
    accumulateDeepestClear(pending, "aisha", 0);
    expect(pending.get("kevin")).toBe(1);
    expect(pending.get("aisha")).toBe(0);
  });
});

describe("history array helpers", () => {
  it("truncateHistoryThroughPosition drops the target position and everything newer", () => {
    // history[0] is newest; truncating through position 1 keeps only the older tail.
    expect(truncateHistoryThroughPosition(["N", "OFF", "AM", "PM"], 1)).toEqual(["AM", "PM"]);
    expect(truncateHistoryThroughPosition(["N", "OFF"], 1)).toEqual([]);
  });

  it("prependHistoryEntry adds the new entry as the newest (index 0)", () => {
    expect(prependHistoryEntry(["AM"], "OFF")).toEqual(["OFF", "AM"]);
    expect(prependHistoryEntry([], "LEAVE")).toEqual(["LEAVE"]);
  });

  it("updateHistoryAtPosition replaces one entry in place", () => {
    expect(updateHistoryAtPosition(["N", "OFF", "AM"], 1, "PM")).toEqual(["N", "PM", "AM"]);
  });
});
