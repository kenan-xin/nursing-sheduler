import { describe, expect, it } from "vitest";
import {
  aggregateSign,
  buildColumns,
  buildRows,
  buildShiftTypeOrderIndex,
  cellAlpha,
  cellDisplay,
  cellPreferenceOf,
  cellPreferenceSet,
  comparePreferences,
  historyColumnCount,
  historyColumnLabels,
  historyLayout,
  historyOffset,
  historyValueAt,
  isHistorySlotClickable,
  sortPreferences,
  resolveDayStatePrecedence,
  weightDisplayLabel,
  type CellPreference,
} from "./requests-model";
import type { UiPeopleGroup, UiPerson, UiRequestCell } from "@/lib/scenario";

const orderIndex = buildShiftTypeOrderIndex(["Day", "Night", "AM", "PM", "GROUP_A"]);

describe("weightDisplayLabel (FR-SR-14/43)", () => {
  it("renders infinities and zero verbatim", () => {
    expect(weightDisplayLabel(Infinity)).toBe("+∞");
    expect(weightDisplayLabel(-Infinity)).toBe("-∞");
    expect(weightDisplayLabel(0)).toBe("0");
  });

  it("prefixes positives and abbreviates via k/m/b/t (old-app parity)", () => {
    expect(weightDisplayLabel(5)).toBe("+5");
    expect(weightDisplayLabel(-5)).toBe("-5");
    expect(weightDisplayLabel(1200)).toBe("+1.2k");
    expect(weightDisplayLabel(2000)).toBe("+2k");
    expect(weightDisplayLabel(-10000)).toBe("-10k");
    expect(weightDisplayLabel(3_000_000)).toBe("+3m");
  });
});

describe("cellPreferenceOf", () => {
  it("projects leave/off/request cells to {shiftType, weight}", () => {
    expect(cellPreferenceOf({ kind: "leave", person: "p", date: "1" })).toEqual({
      shiftType: "LEAVE",
      weight: Infinity,
    });
    expect(cellPreferenceOf({ kind: "off", person: "p", date: "1", weight: -3 })).toEqual({
      shiftType: "OFF",
      weight: -3,
    });
    expect(
      cellPreferenceOf({ kind: "request", person: "p", date: "1", shiftType: "Day", weight: 5 }),
    ).toEqual({ shiftType: "Day", weight: 5 });
  });
});

describe("comparePreferences (FR-SR-12)", () => {
  it("orders by descending magnitude first", () => {
    const prefs: CellPreference[] = [
      { shiftType: "Day", weight: 2 },
      { shiftType: "Night", weight: -10 },
      { shiftType: "AM", weight: 5 },
    ];
    expect(sortPreferences(prefs, orderIndex).map((p) => p.shiftType)).toEqual([
      "Night",
      "AM",
      "Day",
    ]);
  });

  it("breaks equal-magnitude ties by descending signed weight (positive first)", () => {
    const a: CellPreference = { shiftType: "Day", weight: 5 };
    const b: CellPreference = { shiftType: "Night", weight: -5 };
    expect(comparePreferences(a, b, orderIndex)).toBeLessThan(0); // +5 before -5
    expect(comparePreferences(b, a, orderIndex)).toBeGreaterThan(0);
  });

  it("breaks weight+sign ties by ascending shift-type order index", () => {
    const prefs: CellPreference[] = [
      { shiftType: "PM", weight: 5 },
      { shiftType: "Day", weight: 5 },
      { shiftType: "AM", weight: 5 },
    ];
    // Day(0) < AM(2) < PM(3)
    expect(sortPreferences(prefs, orderIndex).map((p) => p.shiftType)).toEqual(["Day", "AM", "PM"]);
  });

  it("sorts an unknown shift-type id first on a full tie (findIndex -1 parity)", () => {
    const prefs: CellPreference[] = [
      { shiftType: "Day", weight: 5 },
      { shiftType: "UNKNOWN", weight: 5 },
    ];
    expect(sortPreferences(prefs, orderIndex).map((p) => p.shiftType)).toEqual(["UNKNOWN", "Day"]);
  });

  it("does not mutate its input", () => {
    const prefs: CellPreference[] = [
      { shiftType: "Day", weight: 1 },
      { shiftType: "Night", weight: 9 },
    ];
    const snapshot = [...prefs];
    sortPreferences(prefs, orderIndex);
    expect(prefs).toEqual(snapshot);
  });
});

describe("cellDisplay (FR-SR-13/14)", () => {
  const pref = (shiftType: string, weight: number): CellPreference => ({ shiftType, weight });

  it("shows all when exactly 3 preferences (no +N more)", () => {
    const result = cellDisplay([pref("Day", 3), pref("Night", 2), pref("AM", 1)], orderIndex);
    expect(result.entries).toHaveLength(3);
    expect(result.moreCount).toBe(0);
    expect(result.entries[0].label).toBe("Day (+3)");
  });

  it("shows top 2 + '+{total-2} more' when 4 preferences", () => {
    const result = cellDisplay(
      [pref("Day", 4), pref("Night", 3), pref("AM", 2), pref("PM", 1)],
      orderIndex,
    );
    expect(result.entries.map((e) => e.shiftType)).toEqual(["Day", "Night"]);
    expect(result.moreCount).toBe(2); // total(4) - 2
  });

  it("labels entries as '{shiftType} ({weightDisplayLabel})'", () => {
    const result = cellDisplay([pref("Night", -1200)], orderIndex);
    expect(result.entries[0].label).toBe("Night (-1.2k)");
  });

  it("handles an empty set", () => {
    const result = cellDisplay([], orderIndex);
    expect(result.entries).toHaveLength(0);
    expect(result.moreCount).toBe(0);
  });
});

describe("aggregateSign (FR-SR-15)", () => {
  it("is all-positive/all-negative/mixed by sign", () => {
    expect(
      aggregateSign([
        { shiftType: "a", weight: 1 },
        { shiftType: "b", weight: 5 },
      ]),
    ).toBe("all-positive");
    expect(
      aggregateSign([
        { shiftType: "a", weight: -1 },
        { shiftType: "b", weight: -5 },
      ]),
    ).toBe("all-negative");
    expect(
      aggregateSign([
        { shiftType: "a", weight: 1 },
        { shiftType: "b", weight: -5 },
      ]),
    ).toBe("mixed");
  });
});

describe("cellAlpha (FR-SR-16)", () => {
  it("floors a zero-weight cell at 0.05", () => {
    expect(cellAlpha([{ shiftType: "a", weight: 0 }])).toBe(0.05);
  });

  it("computes the clamped-log ratio for a finite weight", () => {
    const alpha = cellAlpha([{ shiftType: "a", weight: 1000 }]);
    expect(alpha).toBeCloseTo(Math.log2(1000) / Math.log2(1_000_000), 12);
  });

  it("treats ±Infinity as magnitude 1,000,000 (α ≈ 1)", () => {
    expect(cellAlpha([{ shiftType: "a", weight: Infinity }])).toBe(1);
    expect(cellAlpha([{ shiftType: "a", weight: -Infinity }])).toBe(1);
  });

  it("clamps a finite weight above 1,000,000 to α = 1", () => {
    expect(cellAlpha([{ shiftType: "a", weight: 5_000_000 }])).toBe(1);
  });

  it("uses the max magnitude across the set", () => {
    const alpha = cellAlpha([
      { shiftType: "a", weight: 2 },
      { shiftType: "b", weight: -64 },
    ]);
    expect(alpha).toBeCloseTo(Math.log2(64) / Math.log2(1_000_000), 12);
  });
});

describe("buildRows (FR-SR-03)", () => {
  it("orders groups first, then people, with the right labels/indices", () => {
    const groups: UiPeopleGroup[] = [
      { id: "Seniors", description: "Senior nurses", members: ["a"] },
    ];
    const staff: UiPerson[] = [{ id: "alice", description: "RN" }, { id: "bob" }];
    const rows = buildRows(groups, staff);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      isGroup: true,
      id: "Seniors",
      label: "Seniors",
      members: ["a"],
    });
    expect(rows[1]).toMatchObject({
      isGroup: false,
      id: "alice",
      label: "1. alice",
      personIndex: 1,
    });
    expect(rows[2]).toMatchObject({ isGroup: false, id: "bob", label: "2. bob", personIndex: 2 });
  });
});

describe("history layout (FR-SR-05..09)", () => {
  const people: UiPerson[] = [
    { id: "p1", history: ["Day", "Night", "AM"] }, // newest-first, length 3
    { id: "p2", history: ["PM"] }, // length 1
    { id: "p3" }, // no history
  ];

  it("count = max history length + 1 (always ≥1)", () => {
    expect(historyColumnCount(people)).toBe(4);
    expect(historyColumnCount([])).toBe(1);
    expect(historyColumnCount([{ id: "x" }])).toBe(1);
  });

  it("labels are H-{count-index}: leftmost highest, rightmost H-1", () => {
    expect(historyColumnLabels(4)).toEqual(["H-4", "H-3", "H-2", "H-1"]);
    expect(historyLayout(people)).toEqual({ count: 4, labels: ["H-4", "H-3", "H-2", "H-1"] });
  });

  it("right-aligns each person by offset = count - history.length", () => {
    const count = 4;
    expect(historyOffset(people[0], count)).toBe(1); // len 3
    expect(historyOffset(people[1], count)).toBe(3); // len 1
    expect(historyOffset(people[2], count)).toBe(4); // len 0
  });

  it("renders history[0] (newest) at the leftmost real slot, oldest at H-1", () => {
    const count = 4;
    // p1: offset 1 → col0 padding, col1 = history[0] (Day, newest, under H-3),
    //     col3 = history[2] (AM, oldest, under H-1)
    expect(historyValueAt(people[0], 0, count)).toBeNull();
    expect(historyValueAt(people[0], 1, count)).toBe("Day");
    expect(historyValueAt(people[0], 2, count)).toBe("Night");
    expect(historyValueAt(people[0], 3, count)).toBe("AM");
    // p2: offset 3 → cols 0-2 padding, col3 = PM (newest & oldest, under H-1)
    expect(historyValueAt(people[1], 2, count)).toBeNull();
    expect(historyValueAt(people[1], 3, count)).toBe("PM");
  });

  it("marks slots clickable at index >= offset - 1 (entries + one padding)", () => {
    const count = 4;
    // p1 offset 1: col0 (padding, offset-1) clickable, all real clickable
    expect(isHistorySlotClickable(people[0], 0, count)).toBe(true);
    expect(isHistorySlotClickable(people[0], 1, count)).toBe(true);
    // p2 offset 3: col1 inert, col2 (padding) clickable
    expect(isHistorySlotClickable(people[1], 1, count)).toBe(false);
    expect(isHistorySlotClickable(people[1], 2, count)).toBe(true);
    expect(isHistorySlotClickable(people[1], 3, count)).toBe(true);
  });
});

describe("buildColumns (FR-SR-04/10)", () => {
  // Jul 2026: 1st = Wed. 4th=Sat, 5th=Sun are the weekend in a 1..7 range.
  const range = { start: "2026-07-01", end: "2026-07-07" };

  it("emits synthetic ALL/WEEKDAY/WEEKEND first, in order, with counts", () => {
    const cols = buildColumns(range, []);
    const synthetic = cols.filter((c) => c.kind === "date-group" && c.synthetic);
    expect(synthetic.map((c) => c.ref)).toEqual(["ALL", "WEEKDAY", "WEEKEND"]);
    expect(synthetic).toMatchObject([
      { ref: "ALL", count: 7 },
      { ref: "WEEKDAY", count: 5 },
      { ref: "WEEKEND", count: 2 },
    ]);
  });

  it("includes custom date groups after synthetic, excluding reserved keyword ids", () => {
    const cols = buildColumns(range, [
      { id: "MyGroup", description: "custom" },
      { id: "WEEKEND" }, // reserved keyword — must be excluded
      { id: "ALL" },
    ]);
    const groups = cols.filter((c) => c.kind === "date-group");
    const customs = groups.filter((c) => c.kind === "date-group" && !c.synthetic);
    expect(customs.map((c) => c.ref)).toEqual(["MyGroup"]);
    // synthetic keyword columns still present exactly once
    expect(groups.filter((c) => c.ref === "WEEKEND")).toHaveLength(1);
  });

  it("emits date items last, carrying iso + weekend flag on items only", () => {
    const cols = buildColumns(range, []);
    const items = cols.filter((c) => c.kind === "date-item");
    expect(items).toHaveLength(7);
    const sat = items.find((c) => c.kind === "date-item" && c.iso === "2026-07-04");
    const wed = items.find((c) => c.kind === "date-item" && c.iso === "2026-07-01");
    expect(sat).toMatchObject({ weekend: true });
    expect(wed).toMatchObject({ weekend: false });
    // date groups never carry a weekend flag
    expect(cols.filter((c) => c.kind === "date-group").every((c) => !("weekend" in c))).toBe(true);
  });

  it("emits only the three synthetic columns for an empty range", () => {
    const cols = buildColumns({ start: "", end: "" }, []);
    expect(cols).toHaveLength(3);
    expect(cols).toMatchObject([
      { ref: "ALL", count: 0 },
      { ref: "WEEKDAY", count: 0 },
      { ref: "WEEKEND", count: 0 },
    ]);
  });
});

describe("cellPreferenceSet (FR-SR-11)", () => {
  const reqData: UiRequestCell[] = [
    { kind: "request", person: "alice", date: "01", shiftType: "Day", weight: 5 },
    { kind: "off", person: "alice", date: "01", weight: -1 },
    { kind: "request", person: "alice", date: "02", shiftType: "Night", weight: 3 },
    { kind: "leave", person: "Seniors", date: "WEEKEND" },
    { kind: "request", person: "alice", date: "WEEKEND", shiftType: "AM", weight: 2 },
  ];

  it("matches a person-item × date-item coordinate (all cells at it)", () => {
    const set = cellPreferenceSet(reqData, "alice", "01");
    expect(set).toHaveLength(2);
    expect(set.map((c) => c.kind).sort()).toEqual(["off", "request"]);
  });

  it("matches a date-group/keyword ref and a people-group person ref", () => {
    expect(cellPreferenceSet(reqData, "Seniors", "WEEKEND")).toEqual([
      { kind: "leave", person: "Seniors", date: "WEEKEND" },
    ]);
    expect(cellPreferenceSet(reqData, "alice", "WEEKEND")).toEqual([
      { kind: "request", person: "alice", date: "WEEKEND", shiftType: "AM", weight: 2 },
    ]);
  });

  it("returns an empty set for a coordinate with no cells", () => {
    expect(cellPreferenceSet(reqData, "bob", "01")).toEqual([]);
  });

  it("uses strict === so a numeric id never collapses with its string spelling", () => {
    const numeric: UiRequestCell[] = [
      { kind: "request", person: 5, date: 1, shiftType: "Day", weight: 1 },
    ];
    expect(cellPreferenceSet(numeric, 5, 1)).toHaveLength(1);
    expect(cellPreferenceSet(numeric, "5", "1")).toHaveLength(0);
  });
});

describe("resolveDayStatePrecedence", () => {
  it("passes conflict-free reqData through unchanged (order preserved)", () => {
    const reqData: UiRequestCell[] = [
      { kind: "request", person: "alice", date: "01", shiftType: "AM", weight: 5 },
      { kind: "request", person: "alice", date: "01", shiftType: "PM", weight: -2 },
      { kind: "leave", person: "bob", date: "02" },
      { kind: "off", person: "alice", date: "03", weight: 1 },
    ];
    expect(resolveDayStatePrecedence(reqData)).toEqual(reqData);
  });

  it("a coordinate holding leave + request emits only the LEAVE cell", () => {
    const leave: UiRequestCell = { kind: "leave", person: "alice", date: "01" };
    const resolved = resolveDayStatePrecedence([
      { kind: "request", person: "alice", date: "01", shiftType: "AM", weight: 5 },
      leave,
      { kind: "request", person: "alice", date: "01", shiftType: "PM", weight: -2 },
    ]);
    expect(resolved).toEqual([leave]);
  });

  it("a coordinate holding off + request emits only the OFF cell", () => {
    const off: UiRequestCell = { kind: "off", person: "alice", date: "01", weight: -3 };
    const resolved = resolveDayStatePrecedence([
      { kind: "request", person: "alice", date: "01", shiftType: "AM", weight: 5 },
      off,
    ]);
    expect(resolved).toEqual([off]);
  });

  it("leave beats off at the same coordinate", () => {
    const leave: UiRequestCell = { kind: "leave", person: "alice", date: "01" };
    const resolved = resolveDayStatePrecedence([
      { kind: "off", person: "alice", date: "01", weight: 1 },
      leave,
      { kind: "request", person: "alice", date: "01", shiftType: "AM", weight: 5 },
    ]);
    expect(resolved).toEqual([leave]);
  });

  it("resolves each coordinate independently, preserving first-appearance order", () => {
    const reqData: UiRequestCell[] = [
      { kind: "request", person: "alice", date: "01", shiftType: "AM", weight: 5 },
      { kind: "leave", person: "alice", date: "01" },
      { kind: "request", person: "bob", date: "02", shiftType: "PM", weight: 2 },
    ];
    expect(resolveDayStatePrecedence(reqData)).toEqual([
      { kind: "leave", person: "alice", date: "01" },
      { kind: "request", person: "bob", date: "02", shiftType: "PM", weight: 2 },
    ]);
  });

  it("uses strict identity so a numeric id never collapses with its string spelling", () => {
    const reqData: UiRequestCell[] = [
      { kind: "leave", person: 5, date: 1 },
      { kind: "request", person: "5", date: "1", shiftType: "AM", weight: 1 },
    ];
    // Different coordinates (number vs string ids) — no precedence suppression.
    expect(resolveDayStatePrecedence(reqData)).toHaveLength(2);
  });
});
