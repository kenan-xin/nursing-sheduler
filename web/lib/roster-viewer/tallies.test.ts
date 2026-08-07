// Tallies and date-span label tests (F4).

import { describe, expect, it } from "vitest";
import { computeTallies } from "./tallies";
import { dateLabel, isNewMonth, isNewYear, rosterSpanTitle } from "./date-span";
import { buildProvenanceView } from "./provenance";
import type {
  RosterContext,
  RosterDayGrid,
  RosterDayState,
  RosterCalendarDay,
  RosterProvenance,
} from "@/lib/roster/types";

const D: RosterDayState = { kind: "shift", shiftId: "D" };
const N: RosterDayState = { kind: "shift", shiftId: "N" };
const OFF: RosterDayState = { kind: "off" };
const LEAVE: RosterDayState = { kind: "leave" };

function ctx(): RosterContext {
  return {
    people: [{ id: "Alice" }, { id: "Bob" }],
    shiftTypes: [{ id: "D" }, { id: "N" }],
    calendar: [],
    baselineMinimums: [
      { shiftId: "D", required: 1, source: "p[0]" },
      { shiftId: "N", required: 1, source: "p[1]" },
    ],
    leaveCreditMinutes: null,
  };
}

describe("computeTallies", () => {
  it("counts shift-type totals plus OFF and Leave per nurse", () => {
    const grid: RosterDayGrid = [
      [D, OFF, N, LEAVE],
      [N, D, OFF, D],
    ];
    const tallies = computeTallies(ctx(), grid);
    expect(tallies[0]).toEqual({
      personIdx: 0,
      shiftCounts: [1, 1],
      off: 1,
      leave: 1,
    });
    expect(tallies[1]).toEqual({
      personIdx: 1,
      shiftCounts: [2, 1],
      off: 1,
      leave: 0,
    });
  });

  it("returns zero counts for a nurse with no worked shifts", () => {
    const grid: RosterDayGrid = [
      [OFF, OFF],
      [OFF, OFF],
    ];
    const tallies = computeTallies(ctx(), grid);
    expect(tallies[0].shiftCounts).toEqual([0, 0]);
    expect(tallies[0].off).toBe(2);
    expect(tallies[0].leave).toBe(0);
  });
});

describe("dateLabel", () => {
  const cal = (isos: string[]): RosterCalendarDay[] =>
    isos.map((iso) => ({
      iso,
      weekday: "X",
      weekend: false,
      holiday: false,
    }));

  it("shows the full YYYY-MM-DD on the first day", () => {
    expect(dateLabel(cal(["2026-07-01", "2026-07-02"]), 0)).toBe("2026-07-01");
  });

  it("shows DD within the same month", () => {
    expect(dateLabel(cal(["2026-07-01", "2026-07-02"]), 1)).toBe("02");
  });

  it("shows MM-DD on the first day of a new month", () => {
    expect(dateLabel(cal(["2026-07-31", "2026-08-01"]), 1)).toBe("08-01");
  });

  it("shows YYYY-MM-DD on the first day of a new year", () => {
    expect(dateLabel(cal(["2026-12-31", "2027-01-01"]), 1)).toBe("2027-01-01");
  });

  it("detects month and year boundaries", () => {
    const calendar = cal(["2026-12-31", "2027-01-01", "2027-02-01"]);
    expect(isNewMonth(calendar, 1)).toBe(true);
    expect(isNewYear(calendar, 1)).toBe(true);
    expect(isNewMonth(calendar, 2)).toBe(true);
    expect(isNewYear(calendar, 2)).toBe(false);
    expect(isNewMonth(calendar, 0)).toBe(false);
  });
});

describe("rosterSpanTitle", () => {
  it("returns start → end", () => {
    const cal: RosterCalendarDay[] = [
      { iso: "2026-07-01", weekday: "Wed", weekend: false, holiday: false },
      { iso: "2026-07-06", weekday: "Mon", weekend: false, holiday: false },
    ];
    expect(rosterSpanTitle(cal)).toBe("2026-07-01 → 2026-07-06");
  });

  it("returns empty for an empty calendar", () => {
    expect(rosterSpanTitle([])).toBe("");
  });
});

describe("buildProvenanceView", () => {
  it("uppercases the status and stringifies the score", () => {
    const provenance: RosterProvenance = {
      solverStatus: "OPTIMAL",
      score: 1234,
      solvedBaselineId: "a".repeat(64),
      appBuild: "test",
    };
    const view = buildProvenanceView(provenance, false);
    expect(view.solverStatus).toBe("OPTIMAL");
    expect(view.score).toBe("1234");
    expect(view.editedSinceSolve).toBe(false);
  });

  it("uppercases FEASIBLE too", () => {
    const provenance: RosterProvenance = {
      solverStatus: "FEASIBLE",
      score: -5,
      solvedBaselineId: "b".repeat(64),
      appBuild: "test",
    };
    expect(buildProvenanceView(provenance, true).solverStatus).toBe("FEASIBLE");
  });
});
