// Shift start-time ramp tests (F4). The ramp is a FIXED eight-entry palette;
// the point of these tests is that the assignment is by START TIME (mornings
// warm, nights cool), stable, and collapses overflow into the dark entry.

import { describe, expect, it } from "vitest";
import { assignShiftRamp, SHIFT_RAMP } from "./shift-ramp";

describe("SHIFT_RAMP", () => {
  it("has exactly eight entries", () => {
    expect(SHIFT_RAMP).toHaveLength(8);
  });

  it("entries are the literal DESIGN.md hexes", () => {
    expect(SHIFT_RAMP[0]).toEqual({ fill: "#f8e2b8", ink: "#7a5310", bar: "#d4a038" });
    expect(SHIFT_RAMP[7]).toEqual({ fill: "#2b2733", ink: "#ece6f2", bar: "#5c5468" });
  });
});

describe("assignShiftRamp", () => {
  it("assigns positions by start time ascending (morning first)", () => {
    const shifts = [
      { id: "N", startTime: "21:00" },
      { id: "D", startTime: "07:00" },
      { id: "L", startTime: "13:00" },
    ];
    const ramp = assignShiftRamp(shifts);
    // D (07:00) → position 0 (amber morning); L (13:00) → position 1; N (21:00) → position 2.
    expect(ramp.get("s:D")).toBe(SHIFT_RAMP[0]);
    expect(ramp.get("s:L")).toBe(SHIFT_RAMP[1]);
    expect(ramp.get("s:N")).toBe(SHIFT_RAMP[2]);
  });

  it("preserves axis order for shifts sharing a start time", () => {
    const shifts = [
      { id: "A", startTime: "08:00" },
      { id: "B", startTime: "08:00" },
    ];
    const ramp = assignShiftRamp(shifts);
    expect(ramp.get("s:A")).toBe(SHIFT_RAMP[0]);
    expect(ramp.get("s:B")).toBe(SHIFT_RAMP[1]);
  });

  it("shifts a shift with no startTime to the end", () => {
    const shifts = [
      { id: "N", startTime: "21:00" },
      { id: "?", startTime: undefined },
      { id: "D", startTime: "07:00" },
    ];
    const ramp = assignShiftRamp(shifts);
    expect(ramp.get("s:D")).toBe(SHIFT_RAMP[0]);
    expect(ramp.get("s:N")).toBe(SHIFT_RAMP[1]);
    expect(ramp.get("s:?")).toBe(SHIFT_RAMP[2]);
  });

  it("collapses more than eight shifts into the dark overflow entry", () => {
    const shifts = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      startTime: `${String(i).padStart(2, "0")}:00`,
    }));
    const ramp = assignShiftRamp(shifts);
    // Positions 0..6 get unique entries; 7, 8, 9 all get the dark overflow (index 7).
    expect(ramp.get("s:7")).toBe(SHIFT_RAMP[7]);
    expect(ramp.get("s:8")).toBe(SHIFT_RAMP[7]);
    expect(ramp.get("s:9")).toBe(SHIFT_RAMP[7]);
    expect(ramp.get("s:0")).toBe(SHIFT_RAMP[0]);
  });

  it("distinguishes numeric and string ids of the same value", () => {
    const shifts = [
      { id: 1, startTime: "07:00" },
      { id: "1", startTime: "08:00" },
    ];
    const ramp = assignShiftRamp(shifts);
    expect(ramp.get("n:1")).toBe(SHIFT_RAMP[0]);
    expect(ramp.get("s:1")).toBe(SHIFT_RAMP[1]);
  });
});
