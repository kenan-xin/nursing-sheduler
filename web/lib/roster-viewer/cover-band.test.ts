// Temporary-cover band rows (d582, spec §4 "Display rows").
//
// The band is a display-only plane below the staff rows: one row per cover name,
// her shift on her dates and nothing anywhere else. The interesting cases are the
// two ways the band can disagree with the solve — a cover the scenario has but the
// solve never counted, and a solved cover the scenario no longer has.

import { describe, expect, it } from "vitest";
import { coverBandRows } from "./cover-band";
import type { RosterCalendarDay, RosterCoverEntry } from "@/lib/roster/types";
import type { UiTemporaryCover } from "@/lib/scenario";

const CALENDAR: RosterCalendarDay[] = [
  { iso: "2026-07-03", weekday: "Fri", weekend: false, holiday: false },
  { iso: "2026-07-04", weekday: "Sat", weekend: true, holiday: false },
  { iso: "2026-07-05", weekday: "Sun", weekend: true, holiday: false },
  { iso: "2026-07-06", weekday: "Mon", weekend: false, holiday: true },
];

function entry(overrides: Partial<RosterCoverEntry> = {}): RosterCoverEntry {
  return { name: "Haseena (Ward 3)", iso: "2026-07-04", shiftId: "D", groups: [], ...overrides };
}

function live(overrides: Partial<UiTemporaryCover> = {}): UiTemporaryCover {
  return { name: "Haseena (Ward 3)", date: "2026-07-04", shiftType: "D", groups: [], ...overrides };
}

describe("coverBandRows (d582)", () => {
  it("with nothing anywhere the band is empty", () => {
    expect(coverBandRows([], [], CALENDAR)).toEqual([]);
  });

  it("a solved cover is one row with her chip on her date only", () => {
    const rows = coverBandRows([entry()], [live()], CALENDAR);
    expect(rows).toEqual([
      {
        name: "Haseena (Ward 3)",
        cells: [null, "D", null, null],
        status: "solved",
      },
    ]);
  });

  it("a solved cover missing from the scenario is REMOVED", () => {
    const rows = coverBandRows([entry()], [], CALENDAR);
    expect(rows[0].status).toBe("removed");
    expect(rows[0].cells).toEqual([null, "D", null, null]);
  });

  it("a live cover the solve never counted is NOT OPTIMIZED", () => {
    const rows = coverBandRows([], [live({ date: "2026-07-05" })], CALENDAR);
    expect(rows[0].status).toBe("not-optimized");
    expect(rows[0].cells).toEqual([null, null, "D", null]);
  });

  it("one name covering two dates is ONE row with both chips", () => {
    const rows = coverBandRows(
      [entry({ iso: "2026-07-05" }), entry()],
      [live({ date: "2026-07-05" }), live()],
      CALENDAR,
    );
    expect(rows).toEqual([
      { name: "Haseena (Ward 3)", cells: [null, "D", "D", null], status: "solved" },
    ]);
  });

  it("the scenario is the truth when a name covers a date with a different shift", () => {
    const rows = coverBandRows([entry({ shiftId: "N" })], [live({ shiftType: "D" })], CALENDAR);
    expect(rows[0]).toEqual({
      name: "Haseena (Ward 3)",
      cells: [null, "D", null, null],
      status: "solved",
    });
  });

  it("a cover outside the roster calendar keeps her row with no chip", () => {
    const rows = coverBandRows([], [live({ date: "2026-08-01" })], CALENDAR);
    expect(rows).toEqual([
      { name: "Haseena (Ward 3)", cells: [null, null, null, null], status: "not-optimized" },
    ]);
  });

  it("two names are ordered by their first date, then by name", () => {
    const rows = coverBandRows(
      [
        entry({ name: "Zara", iso: "2026-07-05" }),
        entry({ name: "Bo", iso: "2026-07-05" }),
        entry({ name: "Ada", iso: "2026-07-03" }),
      ],
      [],
      CALENDAR,
    );
    expect(rows.map((row) => row.name)).toEqual(["Ada", "Bo", "Zara"]);
  });

  it("an added cover and a removed one are different rows, never merged", () => {
    const rows = coverBandRows(
      [entry({ name: "Haseena (Ward 3)" })],
      [live({ name: "Priya (Ward 3)", date: "2026-07-05" })],
      CALENDAR,
    );
    expect(rows.map((row) => [row.name, row.status])).toEqual([
      ["Haseena (Ward 3)", "removed"],
      ["Priya (Ward 3)", "not-optimized"],
    ]);
  });
});
