// Coverage predicate tests (F4). The point is that the baseline rule is
// EXECUTABLE and DISCRIMINATING: a unique simple requirement produces a usable
// minimum, and zero/multiple/scoped cases are unavailable — never a fabricated
// number.

import { describe, expect, it } from "vitest";
import { computeCoverage, dayHealth, summariseCoverage, type DayCoverage } from "./coverage";
import { deriveCurrentDays } from "@/lib/roster";
import type { RosterContext, RosterDayGrid, RosterDayState } from "@/lib/roster/types";

const D: RosterDayState = { kind: "shift", shiftId: "D" };
const N: RosterDayState = { kind: "shift", shiftId: "N" };
const OFF: RosterDayState = { kind: "off" };
const LEAVE: RosterDayState = { kind: "leave" };

function contextWith(
  minimums: Array<{ id: string; required: number } | { id: string; unavailable: true }>,
): RosterContext {
  return {
    people: [{ id: "Alice" }, { id: "Bob" }, { id: "Cara" }],
    shiftTypes: minimums.map((m) => ({ id: m.id })),
    calendar: [
      { iso: "2026-07-01", weekday: "Wed", weekend: false, holiday: false },
      { iso: "2026-07-02", weekday: "Thu", weekend: false, holiday: false },
    ],
    baselineMinimums: minimums.map((m) =>
      "unavailable" in m
        ? { shiftId: m.id, unavailable: true }
        : { shiftId: m.id, required: m.required, source: `preferences[0]` },
    ),
    leaveCreditMinutes: null,
  };
}

/** A 3-person × 2-day grid where day 0 is well-staffed and day 1 is short on D. */
function sampleGrid(): RosterDayGrid {
  return [
    [D, N],
    [D, OFF],
    [N, D],
  ];
}

describe("computeCoverage", () => {
  it("counts staffed vs an available minimum and flags Short", () => {
    const grid = contextWith([{ id: "D", required: 2 }]);
    const coverage = computeCoverage(grid, sampleGrid());

    expect(coverage[0].shifts).toEqual([
      { status: "available", staffed: 2, required: 2, short: false },
    ]);
    expect(coverage[1].shifts).toEqual([
      { status: "available", staffed: 1, required: 2, short: true },
    ]);
    expect(coverage[0].anyShort).toBe(false);
    expect(coverage[1].anyShort).toBe(true);
  });

  it("reports unavailable and never a number when the baseline is unavailable", () => {
    const grid = contextWith([{ id: "N", unavailable: true }]);
    const coverage = computeCoverage(grid, sampleGrid());

    expect(coverage[0].shifts).toEqual([{ status: "unavailable" }]);
    expect(coverage[1].shifts).toEqual([{ status: "unavailable" }]);
    expect(coverage[0].anyShort).toBe(false);
  });

  it("handles a mix of available and unavailable shifts on the same day", () => {
    const grid = contextWith([
      { id: "D", required: 3 },
      { id: "N", unavailable: true },
    ]);
    const coverage = computeCoverage(grid, sampleGrid());

    expect(coverage[0].shifts).toEqual([
      { status: "available", staffed: 2, required: 3, short: true },
      { status: "unavailable" },
    ]);
    expect(coverage[0].anyShort).toBe(true);
  });

  it("ignores OFF and Leave when counting staffed", () => {
    const grid = contextWith([{ id: "D", required: 1 }]);
    const days: RosterDayGrid = [
      [OFF, LEAVE],
      [OFF, OFF],
      [D, D],
    ];
    const coverage = computeCoverage(grid, days);
    expect(coverage[0].shifts[0]).toEqual({
      status: "available",
      staffed: 1,
      required: 1,
      short: false,
    });
    expect(coverage[1].shifts[0]).toEqual({
      status: "available",
      staffed: 1,
      required: 1,
      short: false,
    });
  });

  it("distinguishes numeric shift ids from same-looking string ids", () => {
    const numeric: RosterDayState = { kind: "shift", shiftId: 1 };
    const stringy: RosterDayState = { kind: "shift", shiftId: "1" };
    const grid = contextWith([{ id: 1 as unknown as string, required: 1 }]);
    // The context id is numeric 1; a string "1" must NOT count toward it.
    // Two people × two days: person 0 works numeric-1 both days, person 1 works string-"1" both days.
    const days: RosterDayGrid = [
      [numeric, numeric],
      [stringy, stringy],
    ];
    const coverage = computeCoverage(grid, days);
    expect(coverage[0].shifts[0]).toMatchObject({ staffed: 1 });
  });
});

// The ticket requires coverage to recompute LIVE as edits land. `computeCoverage`
// is pure over the CURRENT day grid, so the claim is that feeding it the overlay
// output moves the numbers — not that it caches nothing.
describe("live recompute over the edit overlay", () => {
  it("moves a lane from staffed to Short when an edit removes its last person", () => {
    const context = contextWith([{ id: "D", required: 1 }]);
    const solved: RosterDayGrid = [
      [D, D],
      [D, D],
    ];
    expect(computeCoverage(context, solved)[0].shifts[0]).toMatchObject({
      staffed: 2,
      short: false,
    });

    // Both people go OFF on day 0: the lane is now empty against a minimum of 1.
    const edited = deriveCurrentDays(solved, [
      { personIdx: 0, dateIdx: 0, day: { kind: "off" } },
      { personIdx: 1, dateIdx: 0, day: { kind: "off" } },
    ]);
    const after = computeCoverage(context, edited);

    expect(after[0].shifts[0]).toMatchObject({ staffed: 0, short: true });
    expect(after[0].anyShort).toBe(true);
    // NEGATIVE CONTROL: the untouched day is unchanged.
    expect(after[1].shifts[0]).toMatchObject({ staffed: 2, short: false });
  });

  it("moves a lane from Short back to staffed when an edit adds a person", () => {
    const context = contextWith([{ id: "D", required: 1 }]);
    const solved: RosterDayGrid = [
      [{ kind: "off" }, D],
      [{ kind: "off" }, D],
    ];
    expect(computeCoverage(context, solved)[0].shifts[0]).toMatchObject({ short: true });

    const edited = deriveCurrentDays(solved, [{ personIdx: 0, dateIdx: 0, day: D }]);
    expect(computeCoverage(context, edited)[0].shifts[0]).toMatchObject({
      staffed: 1,
      short: false,
    });
  });
});

describe("summariseCoverage", () => {
  it("counts under-minimum slots across the whole grid", () => {
    const grid = contextWith([
      { id: "D", required: 2 },
      { id: "N", unavailable: true },
    ]);
    const coverage = computeCoverage(grid, sampleGrid());
    const summary = summariseCoverage(coverage);

    // D: day 0 staffed 2/2 (ok), day 1 staffed 1/2 (short). N: unavailable both days.
    expect(summary.underMinimum).toBe(1);
    expect(summary.totalAvailable).toBe(2);
    expect(summary.allCheckableStaffed).toBe(false);
  });

  it("reports allCheckableStaffed when no available shift is short", () => {
    const grid = contextWith([{ id: "D", required: 1 }]);
    const days: RosterDayGrid = [
      [D, D],
      [D, D],
    ];
    const coverage = computeCoverage(grid, days);
    const summary = summariseCoverage(coverage);
    expect(summary.allCheckableStaffed).toBe(true);
    expect(summary.anyCheckable).toBe(true);
    expect(summary.totalUnavailable).toBe(0);
  });

  // THE DEFECT THIS REPLACES. The previous `allStaffed` was `underMinimum === 0`,
  // so a roster where NOTHING could be checked reported the same value as a
  // roster verified fully staffed — unknown laundered into an all-clear.
  it("does NOT claim staffing when nothing is checkable", () => {
    const grid = contextWith([
      { id: "D", unavailable: true },
      { id: "N", unavailable: true },
    ]);
    const coverage = computeCoverage(grid, sampleGrid());
    const summary = summariseCoverage(coverage);

    expect(summary.underMinimum).toBe(0);
    expect(summary.totalAvailable).toBe(0);
    expect(summary.anyCheckable).toBe(false);
    // The load-bearing assertion: zero shortfalls is NOT an all-clear.
    expect(summary.allCheckableStaffed).toBe(false);
  });

  it("counts unavailable slots so a mixed roster can name them", () => {
    const grid = contextWith([
      { id: "D", required: 1 },
      { id: "N", unavailable: true },
    ]);
    const days: RosterDayGrid = [
      [D, D],
      [D, D],
    ];
    const coverage = computeCoverage(grid, days);
    const summary = summariseCoverage(coverage);

    // Two days x one unavailable lane.
    expect(summary.totalUnavailable).toBe(2);
    expect(summary.totalAvailable).toBe(2);
    // Checkable lanes ARE all staffed — the claim is true but must stay scoped.
    expect(summary.allCheckableStaffed).toBe(true);
    expect(summary.anyCheckable).toBe(true);
  });
});

describe("dayHealth", () => {
  const day = (shifts: DayCoverage["shifts"]): DayCoverage => ({
    iso: "2026-07-01",
    shifts,
    anyShort: shifts.some((s) => s.status === "available" && s.short),
  });

  it("returns 'under' when any available shift is short", () => {
    expect(
      dayHealth(
        day([
          { status: "available", staffed: 0, required: 1, short: true },
          { status: "unavailable" },
        ]),
      ),
    ).toBe("under");
  });

  it("returns 'at' when none short but one exactly at minimum", () => {
    expect(dayHealth(day([{ status: "available", staffed: 2, required: 2, short: false }]))).toBe(
      "at",
    );
  });

  it("returns 'ok' when all above minimum", () => {
    expect(dayHealth(day([{ status: "available", staffed: 3, required: 2, short: false }]))).toBe(
      "ok",
    );
  });

  // THE DEFECT THIS REPLACES. A day with no checkable lane used to return 'ok',
  // which paints the SUCCESS-coloured health dot over a day the predicate never
  // evaluated. Absence of a shortfall is not evidence of coverage.
  it("returns 'unknown' — never 'ok' — when NO shift on the day is checkable", () => {
    const health = dayHealth(day([{ status: "unavailable" }, { status: "unavailable" }]));
    expect(health).toBe("unknown");
    expect(health).not.toBe("ok");
  });

  it("still reports on a mixed day using only its checkable lanes", () => {
    expect(
      dayHealth(
        day([
          { status: "unavailable" },
          { status: "available", staffed: 3, required: 2, short: false },
        ]),
      ),
    ).toBe("ok");
    expect(
      dayHealth(
        day([
          { status: "unavailable" },
          { status: "available", staffed: 1, required: 2, short: true },
        ]),
      ),
    ).toBe("under");
  });

  it("returns 'unknown' for a day with no shift lanes at all", () => {
    expect(dayHealth(day([]))).toBe("unknown");
  });
});
