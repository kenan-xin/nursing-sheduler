// The host operation layer's accept/reject contract (T07).
//
// Each arm is checked at its boundary rather than in its happy middle: an unknown
// target, an illegal value, an unsupported record shape, and a request that is
// already true. Those four are what the Preview has to be able to say, and a
// refusal that produced a confusing message would be a product defect, not a test
// detail -- so the CODE is asserted, not the prose.

import { describe, expect, it } from "vitest";
import { applyAssistantCommand, applyAssistantCommands } from "./operations";
import { proposalScenario } from "./test-support";

describe("set_roster_range", () => {
  it("purges references to dates that leave the range", () => {
    const state = proposalScenario();
    const result = applyAssistantCommand(state, {
      type: "set_roster_range",
      start: "2026-04-01",
      end: "2026-04-15",
      importPublicHolidays: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 29 left the range, so bo's off-preference went with it. 02 and 07 stayed.
    expect(result.next.reqData.map((cell) => cell.uid).sort()).toEqual(["cell-leave", "cell-req"]);
    expect(result.next.rangeEnd).toBe("2026-04-15");
  });

  it("refuses an impossible range and a backwards one", () => {
    const state = proposalScenario();
    const notADate = applyAssistantCommand(state, {
      type: "set_roster_range",
      start: "2026-02-31",
      end: "2026-03-05",
      importPublicHolidays: false,
    });
    expect(notADate.ok).toBe(false);
    if (!notADate.ok) expect(notADate.rejection.code).toBe("invalid_value");

    const backwards = applyAssistantCommand(state, {
      type: "set_roster_range",
      start: "2026-04-30",
      end: "2026-04-01",
      importPublicHolidays: false,
    });
    expect(backwards.ok).toBe(false);
    if (!backwards.ok) expect(backwards.rejection.code).toBe("invalid_value");
  });

  it("refuses the same range when nothing else was asked for", () => {
    const result = applyAssistantCommand(proposalScenario(), {
      type: "set_roster_range",
      start: "2026-04-01",
      end: "2026-04-30",
      importPublicHolidays: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.code).toBe("no_effect");
  });
});

describe("set_rule_enabled", () => {
  it("sets and clears the marker, and refuses a rule that is already in that state", () => {
    const state = proposalScenario();
    const off = applyAssistantCommand(state, {
      type: "set_rule_enabled",
      ruleKind: "requirements",
      ruleId: "req-day",
      enabled: false,
    });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.next.cardsByKind.requirements[0].disabled).toBe(true);

    const again = applyAssistantCommand(off.next, {
      type: "set_rule_enabled",
      ruleKind: "requirements",
      ruleId: "req-day",
      enabled: false,
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.rejection.code).toBe("no_effect");

    // Re-enabling REMOVES the marker rather than setting it false, exactly as the
    // manual toggle does -- a `disabled: false` key would serialize differently.
    const on = applyAssistantCommand(off.next, {
      type: "set_rule_enabled",
      ruleKind: "requirements",
      ruleId: "req-day",
      enabled: true,
    });
    expect(on.ok).toBe(true);
    if (on.ok) expect("disabled" in on.next.cardsByKind.requirements[0]).toBe(false);
  });

  it("refuses a rule that is not in the document", () => {
    const result = applyAssistantCommand(proposalScenario(), {
      type: "set_rule_enabled",
      ruleKind: "counts",
      ruleId: "never-existed",
      enabled: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.code).toBe("unknown_target");
  });
});

describe("set_staffing_requirement_people", () => {
  it("changes a single-target requirement", () => {
    const result = applyAssistantCommand(proposalScenario(), {
      type: "set_staffing_requirement_people",
      ruleId: "req-day",
      requiredNumPeople: 3,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next.cardsByKind.requirements[0].requiredNumPeople).toBe(3);
  });

  it("refuses a multi-target requirement, a negative count, and an unchanged count", () => {
    const state = proposalScenario();
    const multi = applyAssistantCommand(state, {
      type: "set_staffing_requirement_people",
      ruleId: "req-multi",
      requiredNumPeople: 4,
    });
    expect(multi.ok).toBe(false);
    if (!multi.ok) expect(multi.rejection.code).toBe("unsupported_shape");

    const negative = applyAssistantCommand(state, {
      type: "set_staffing_requirement_people",
      ruleId: "req-day",
      requiredNumPeople: -1,
    });
    expect(negative.ok).toBe(false);
    if (!negative.ok) expect(negative.rejection.code).toBe("invalid_value");

    const same = applyAssistantCommand(state, {
      type: "set_staffing_requirement_people",
      ruleId: "req-day",
      requiredNumPeople: 2,
    });
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.rejection.code).toBe("no_effect");
  });
});

describe("move_leave", () => {
  it("relocates the pin, keeping its durable identity", () => {
    const result = applyAssistantCommand(proposalScenario(), {
      type: "move_leave",
      personId: "ana",
      fromDate: "02",
      toDate: "10",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const moved = result.next.reqData.filter((cell) => cell.person === "ana");
    expect(moved.find((cell) => cell.date === "02")).toBeUndefined();
    // Same `uid`: it is one agreement on a different day, not a new one. This is
    // also what makes the operation deterministic across Preview and Apply.
    expect(moved.find((cell) => cell.date === "10")).toMatchObject({
      uid: "cell-leave",
      kind: "leave",
    });
  });

  it("replaces whatever the destination held, so the displaced cell is visible", () => {
    const result = applyAssistantCommand(proposalScenario(), {
      type: "move_leave",
      personId: "ana",
      fromDate: "02",
      toDate: "07",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The Day request that lived on the 7th is gone, replaced by the leave pin --
    // the manual cell editor's own "a saved cell is the whole coordinate" rule.
    expect(result.next.reqData.some((cell) => cell.uid === "cell-req")).toBe(false);
  });

  it("refuses an unknown person, an out-of-range date, and a date with no leave", () => {
    const state = proposalScenario();
    for (const command of [
      { type: "move_leave", personId: "nobody", fromDate: "02", toDate: "10" },
      { type: "move_leave", personId: "ana", fromDate: "02", toDate: "99" },
      { type: "move_leave", personId: "ana", fromDate: "11", toDate: "12" },
    ] as const) {
      const result = applyAssistantCommand(state, command);
      expect(result.ok, JSON.stringify(command)).toBe(false);
      if (!result.ok) expect(result.rejection.code).toBe("unknown_target");
    }

    const same = applyAssistantCommand(state, {
      type: "move_leave",
      personId: "ana",
      fromDate: "02",
      toDate: "02",
    });
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.rejection.code).toBe("no_effect");
  });
});

describe("batches", () => {
  it("validates each command against the document the previous one produced", () => {
    // Moving ana's leave onto the 10th and THEN off it again is only coherent if the
    // second command sees the first one's result.
    const result = applyAssistantCommands(proposalScenario(), [
      { type: "move_leave", personId: "ana", fromDate: "02", toDate: "10" },
      { type: "move_leave", personId: "ana", fromDate: "10", toDate: "12" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.reqData.find((cell) => cell.uid === "cell-leave")?.date).toBe("12");
    }
  });

  it("fails closed on the first refusal, reporting which command it was", () => {
    const result = applyAssistantCommands(proposalScenario(), [
      {
        type: "set_staffing_requirement_people",
        ruleId: "req-day",
        requiredNumPeople: 3,
      },
      { type: "move_leave", personId: "ana", fromDate: "11", toDate: "12" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection.index).toBe(1);
      expect(result.rejection.code).toBe("unknown_target");
    }
  });
});

describe("add_shift_type / add_shift_group", () => {
  const shift = (code: string, startTime: string, endTime: string, name = "", restMinutes = 0) => ({
    type: "add_shift_type" as const,
    code,
    name,
    startTime,
    endTime,
    restMinutes,
  });
  const group = (groupId: string, members: string[]) => ({
    type: "add_shift_group" as const,
    groupId,
    members,
  });

  it("sets up the ward's whole shift list in one batch", () => {
    // The real request: am1-3, pm1-3, a long shift and an overnight night shift, grouped.
    const result = applyAssistantCommands(proposalScenario(), [
      shift("am1", "08:00", "15:00"),
      shift("am2", "08:00", "16:00"),
      shift("am3", "08:00", "17:00"),
      shift("pm1", "12:00", "21:00"),
      shift("pm2", "13:00", "21:00"),
      shift("pm3", "14:00", "21:00"),
      shift("L", "08:00", "20:30", "Long shift"),
      shift("N", "20:00", "08:30", "Night shift"),
      group("AM", ["am1", "am2", "am3"]),
      group("PM", ["pm1", "pm2", "pm3"]),
      group("Long", ["L"]),
      group("Night shifts", ["N"]),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const added = result.next.shifts.slice(2);
    expect(added.map((s) => s.id)).toEqual(["am1", "am2", "am3", "pm1", "pm2", "pm3", "L", "N"]);
    expect(added.find((s) => s.id === "am1")).toMatchObject({
      startTime: "08:00",
      endTime: "15:00",
      durationMinutes: 420,
    });
    // Overnight: 20:00 -> 08:30 next day is 12.5 hours.
    expect(added.find((s) => s.id === "N")).toMatchObject({
      description: "Night shift",
      startTime: "20:00",
      endTime: "08:30",
      durationMinutes: 750,
    });
    expect(result.next.shiftGroups.map((g) => [g.id, g.members])).toEqual([
      ["AM", ["am1", "am2", "am3"]],
      ["PM", ["pm1", "pm2", "pm3"]],
      ["Long", ["L"]],
      ["Night shifts", ["N"]],
    ]);
  });

  it("trims the code and drops an empty name, as the Shifts page does", () => {
    const result = applyAssistantCommand(
      proposalScenario(),
      shift("  am1  ", "08:00", "15:00", "  "),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const created = result.next.shifts.at(-1);
    expect(created?.id).toBe("am1");
    expect(created?.description).toBeUndefined();
  });

  it("refuses a code that already exists, naming it", () => {
    const result = applyAssistantCommand(proposalScenario(), shift("Day", "08:00", "15:00"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("invalid_value");
    expect(result.rejection.message).toContain('Shift "Day"');
  });

  it("refuses a duplicate inside the batch at the second occurrence", () => {
    const result = applyAssistantCommands(proposalScenario(), [
      shift("am1", "08:00", "15:00"),
      shift("am1", "08:00", "16:00"),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.index).toBe(1);
    expect(result.rejection.message).toContain('Shift "am1"');
  });

  it("accepts a case-variant code, as the Shifts page does", () => {
    // Ids are exact-identity across the app; `Night` and `NIGHT` are distinct.
    expect(applyAssistantCommand(proposalScenario(), shift("NIGHT", "20:00", "08:30")).ok).toBe(
      true,
    );
  });

  it("refuses reserved, numbers-only and empty codes", () => {
    for (const code of ["OFF", "all", "123", "   "]) {
      const result = applyAssistantCommand(proposalScenario(), shift(code, "08:00", "15:00"));
      expect(result.ok, code).toBe(false);
      if (!result.ok) expect(result.rejection.code).toBe("invalid_value");
    }
  });

  it("refuses an off-grid time", () => {
    const result = applyAssistantCommand(proposalScenario(), shift("am1", "08:15", "15:00"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.message).toContain('Shift "am1"');
    expect(result.rejection.message).toContain("30-minute grid");
  });

  it("refuses a shift whose start and end are the same", () => {
    expect(applyAssistantCommand(proposalScenario(), shift("x", "08:00", "08:00")).ok).toBe(false);
  });

  it("treats rest 0 as no break: paid minutes are the full span", () => {
    const result = applyAssistantCommand(proposalScenario(), shift("L", "08:00", "20:30", "", 0));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const created = result.next.shifts.at(-1);
    expect(created?.durationMinutes).toBe(750);
    // Stored as the Shifts page stores it: rest absent, not `restMinutes: 0`.
    expect(created?.restMinutes).toBeUndefined();
  });

  it("subtracts a rest break from the paid minutes, overnight too", () => {
    const result = applyAssistantCommand(proposalScenario(), shift("N", "20:00", "08:30", "", 60));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.next.shifts.at(-1)).toMatchObject({ restMinutes: 60, durationMinutes: 690 });
  });

  it("refuses a rest the Shifts page cannot hold, naming the shift", () => {
    for (const [restMinutes, text] of [
      [-30, "non-negative multiple of 30"],
      [45, "non-negative multiple of 30"],
      [420, "less than the shift span"], // 08:00-15:00 span is 420
      [480, "less than the shift span"],
    ] as const) {
      const result = applyAssistantCommand(
        proposalScenario(),
        shift("am1", "08:00", "15:00", "", restMinutes),
      );
      expect(result.ok, String(restMinutes)).toBe(false);
      if (result.ok) continue;
      expect(result.rejection.code).toBe("invalid_value");
      expect(result.rejection.message).toContain('Shift "am1"');
      expect(result.rejection.message).toContain(text);
    }
  });

  it("refuses a group id that is already a shift code", () => {
    const result = applyAssistantCommand(proposalScenario(), group("Night", ["Day"]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("invalid_value");
    expect(result.rejection.message).toContain('Shift group "Night"');
  });

  it("refuses a group whose shift comes later in the batch", () => {
    const result = applyAssistantCommands(proposalScenario(), [
      group("AM", ["am1"]),
      shift("am1", "08:00", "15:00"),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.index).toBe(0);
    expect(result.rejection.code).toBe("unknown_target");
    expect(result.rejection.message).toContain('"am1"');
  });

  it("puts group members in shift order and ignores repeats", () => {
    const result = applyAssistantCommand(
      proposalScenario(),
      group("Both", ["Night", "Day", "Night"]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next.shiftGroups.at(-1)?.members).toEqual(["Day", "Night"]);
  });
});
