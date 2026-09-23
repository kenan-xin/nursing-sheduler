import { describe, expect, it } from "vitest";
import { assignShiftRamp, classifyShiftFamily, SHIFT_FAMILY_RAMP, SHIFT_RAMP } from "./shift-ramp";

describe("SHIFT_RAMP", () => {
  it("has exactly five entries: four families plus the unparseable-time fallback", () => {
    expect(SHIFT_RAMP).toHaveLength(5);
  });

  it("entries are the literal DESIGN.md hexes", () => {
    expect(SHIFT_RAMP[0]).toEqual({ fill: "#f8e2b8", ink: "#7a5310", bar: "#d4a038" }); // morning
    expect(SHIFT_RAMP[4]).toEqual({ fill: "#2b2733", ink: "#ece6f2", bar: "#5c5468" }); // other
  });
});

describe("classifyShiftFamily", () => {
  // Ward-8 (core/tests/testcases/real/ward-8-shift-patterns-senior-on-every-shift.yaml)
  it("classifies Ward-8's am1/am2/am3 patterns as morning", () => {
    expect(classifyShiftFamily({ startTime: "08:00", endTime: "15:00" })).toBe("morning");
    expect(classifyShiftFamily({ startTime: "08:00", endTime: "16:00" })).toBe("morning");
    expect(classifyShiftFamily({ startTime: "08:00", endTime: "17:00" })).toBe("morning");
  });

  it("classifies Ward-8's pm1/pm2/pm3 patterns as evening", () => {
    expect(classifyShiftFamily({ startTime: "12:00", endTime: "21:00" })).toBe("evening");
    expect(classifyShiftFamily({ startTime: "13:00", endTime: "21:00" })).toBe("evening");
    expect(classifyShiftFamily({ startTime: "14:00", endTime: "21:00" })).toBe("evening");
  });

  it("classifies Ward-8's long pattern as long day, not morning, despite an 08:00 start", () => {
    // 690 = 11.5h paid, net of a 60-min unpaid break on this 12.5h clock span —
    // real scenario shift types always carry `durationMinutes` alongside
    // `startTime`/`endTime` (core/nurse_scheduling/models.py requires it), so
    // this exercises the paid-minutes branch of `resolveDurationMinutes`, not
    // just its elapsed-time-span fallback.
    expect(
      classifyShiftFamily({ startTime: "08:00", endTime: "20:30", durationMinutes: 690 }),
    ).toBe("long");
  });

  it("classifies Ward-8's night pattern as night, not long day, despite a 12.5h duration", () => {
    expect(
      classifyShiftFamily({ startTime: "20:00", endTime: "08:30", durationMinutes: 690 }),
    ).toBe("night");
  });

  // The real Ward 2 paper roster printout, same shift shapes under different names.
  it("classifies the Ward 2 printout's A15/A16/A18 as morning", () => {
    expect(classifyShiftFamily({ startTime: "08:00", endTime: "15:00" })).toBe("morning");
    expect(classifyShiftFamily({ startTime: "08:00", endTime: "17:00" })).toBe("morning");
  });

  it("classifies the Ward 2 printout's P12/P7/P2 as evening", () => {
    expect(classifyShiftFamily({ startTime: "12:00", endTime: "21:00" })).toBe("evening");
    expect(classifyShiftFamily({ startTime: "14:00", endTime: "21:00" })).toBe("evening");
  });

  it("classifies the Ward 2 printout's LA8 as long day", () => {
    expect(classifyShiftFamily({ startTime: "08:00", endTime: "20:30" })).toBe("long");
  });

  it("classifies the Ward 2 printout's LN8 as night", () => {
    expect(classifyShiftFamily({ startTime: "20:00", endTime: "08:30" })).toBe("night");
  });

  it("prefers authored durationMinutes over a start/end computation", () => {
    // A shift authored with an 11h durationMinutes crosses the long threshold
    // even though its start/end alone would compute 9h — proving
    // durationMinutes wins when present.
    expect(
      classifyShiftFamily({ startTime: "08:00", endTime: "17:00", durationMinutes: 11 * 60 }),
    ).toBe("long");
  });

  it("falls back to other when startTime is missing or unparseable", () => {
    expect(classifyShiftFamily({})).toBe("other");
    expect(classifyShiftFamily({ startTime: "not-a-time" })).toBe("other");
  });
});

describe("assignShiftRamp", () => {
  it("assigns every shift its family's ramp entry, not a per-id position", () => {
    const shifts = [
      { id: "am1", startTime: "08:00", endTime: "15:00" },
      { id: "am1+", startTime: "08:00", endTime: "15:00" },
      { id: "pm1", startTime: "12:00", endTime: "21:00" },
      { id: "long", startTime: "08:00", endTime: "20:30" },
      { id: "night", startTime: "20:00", endTime: "08:30" },
    ];
    const ramp = assignShiftRamp(shifts);
    // am1 and am1+ share the SAME family colour — that's the point, they're
    // both morning shifts. The `+` convention is never inspected.
    expect(ramp.get("s:am1")).toBe(SHIFT_FAMILY_RAMP.morning);
    expect(ramp.get("s:am1+")).toBe(SHIFT_FAMILY_RAMP.morning);
    expect(ramp.get("s:pm1")).toBe(SHIFT_FAMILY_RAMP.evening);
    expect(ramp.get("s:long")).toBe(SHIFT_FAMILY_RAMP.long);
    expect(ramp.get("s:night")).toBe(SHIFT_FAMILY_RAMP.night);
  });

  it("never overflows: Ward-8's real 16-shift catalog still resolves to exactly its 4 families", () => {
    const wardEight = [
      { id: "am1", startTime: "08:00", endTime: "15:00" },
      { id: "am1+", startTime: "08:00", endTime: "15:00" },
      { id: "am2", startTime: "08:00", endTime: "16:00" },
      { id: "am2+", startTime: "08:00", endTime: "16:00" },
      { id: "am3", startTime: "08:00", endTime: "17:00" },
      { id: "am3+", startTime: "08:00", endTime: "17:00" },
      { id: "pm1", startTime: "12:00", endTime: "21:00" },
      { id: "pm1+", startTime: "12:00", endTime: "21:00" },
      { id: "pm2", startTime: "13:00", endTime: "21:00" },
      { id: "pm2+", startTime: "13:00", endTime: "21:00" },
      { id: "pm3", startTime: "14:00", endTime: "21:00" },
      { id: "pm3+", startTime: "14:00", endTime: "21:00" },
      { id: "long", startTime: "08:00", endTime: "20:30" },
      { id: "long+", startTime: "08:00", endTime: "20:30" },
      { id: "night", startTime: "20:00", endTime: "08:30" },
      { id: "night+", startTime: "20:00", endTime: "08:30" },
    ];
    const ramp = assignShiftRamp(wardEight);
    const distinctColours = new Set([...ramp.values()].map((entry) => entry.fill));
    expect(distinctColours.size).toBe(4);
  });

  it("distinguishes numeric and string ids of the same value", () => {
    const shifts = [
      { id: 1, startTime: "08:00", endTime: "15:00" },
      { id: "1", startTime: "12:00", endTime: "21:00" },
    ];
    const ramp = assignShiftRamp(shifts);
    expect(ramp.get("n:1")).toBe(SHIFT_FAMILY_RAMP.morning);
    expect(ramp.get("s:1")).toBe(SHIFT_FAMILY_RAMP.evening);
  });
});
