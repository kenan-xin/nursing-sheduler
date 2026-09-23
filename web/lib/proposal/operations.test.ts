// The host operation layer's accept/reject contract (T07).
//
// Each arm is checked at its boundary rather than in its happy middle: an unknown
// target, an illegal value, an unsupported record shape, and a request that is
// already true. Those four are what the Preview has to be able to say, and a
// refusal that produced a confusing message would be a product defect, not a test
// detail -- so the CODE is asserted, not the prose.

import { describe, expect, it } from "vitest";
import type { ScenarioUiState } from "@/lib/scenario";
import { applyAssistantCommand, applyAssistantCommands } from "./operations";
import { octoberWard, proposalScenario } from "./test-support";

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

describe("leave and request arms", () => {
  const leave = (personId: string | number, startDate: string, endDate = startDate) => ({
    type: "add_leave" as const,
    personId,
    startDate,
    endDate,
  });
  const off = (
    personId: string | number,
    startDate: string,
    endDate: string,
    weight: number | "must" | "never",
  ) => ({ type: "set_off_request" as const, personId, startDate, endDate, weight });
  const wants = (
    personId: string | number,
    shiftType: string,
    startDate: string,
    endDate: string,
    weight: number | "must" | "never",
  ) => ({ type: "set_shift_request" as const, personId, shiftType, startDate, endDate, weight });
  const clear = (personId: string | number, startDate: string, endDate = startDate) => ({
    type: "clear_requests" as const,
    personId,
    startDate,
    endDate,
  });
  /** The cells at one coordinate, without their uids. */
  const at = (state: ScenarioUiState, person: string, date: string) =>
    state.reqData
      .filter((cell) => cell.person === person && cell.date === date)
      .map(({ uid: _uid, ...rest }) => rest);

  it("Ana is on annual leave 10-16 Oct", () => {
    const result = applyAssistantCommand(octoberWard(), leave("Ana", "2026-10-10", "2026-10-16"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const leaveDates = result.next.reqData
      .filter((cell) => cell.person === "Ana" && cell.kind === "leave")
      .map((cell) => cell.date)
      .sort();
    expect(leaveDates).toEqual(["10", "11", "12", "13", "14", "15", "16"]);
    // The leave already on the 14th is the same agreement: its identity survives.
    expect(result.next.reqData.find((c) => c.person === "Ana" && c.date === "14")?.uid).toBe(
      "ana-leave-14",
    );
    // Every cell carries a durable uid (Workspace emission refuses one without).
    expect(result.next.reqData.every((cell) => Boolean(cell.uid))).toBe(true);
  });

  it("mints the same uids every time, so Apply reproduces the Preview", () => {
    const command = leave("Ana", "2026-10-10", "2026-10-16");
    const first = applyAssistantCommand(octoberWard(), command);
    const second = applyAssistantCommand(octoberWard(), command);
    expect(first).toEqual(second);
  });

  it("Ben requests no nights next week", () => {
    const result = applyAssistantCommand(
      octoberWard(),
      wants("Ben", "N", "2026-10-19", "2026-10-25", -5),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const nights = result.next.reqData.filter(
      (cell) => cell.person === "Ben" && cell.kind === "request" && cell.shiftType === "N",
    );
    // The 21st is his day off: skipped, as quick paint skips it.
    expect(nights.map((cell) => cell.date).sort()).toEqual(["19", "20", "22", "23", "24", "25"]);
    expect(nights.every((cell) => cell.kind === "request" && cell.weight === -5)).toBe(true);
    expect(at(result.next, "Ben", "21")).toEqual([
      { kind: "off", person: "Ben", date: "21", weight: 5 },
    ]);
    // His Day request on the 22nd stays alongside.
    expect(at(result.next, "Ben", "22")).toHaveLength(2);
  });

  it("Chris would like the long day on 20 Oct", () => {
    const result = applyAssistantCommand(
      octoberWard(),
      wants("Chris", "L", "2026-10-20", "2026-10-20", 5),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(at(result.next, "Chris", "20")).toEqual([
      { kind: "request", person: "Chris", date: "20", shiftType: "D", weight: 2 },
      { kind: "request", person: "Chris", date: "20", shiftType: "L", weight: 5 },
    ]);
  });

  it('maps "must" and "never" to hard pins', () => {
    const result = applyAssistantCommands(octoberWard(), [
      wants("Chris", "L", "2026-10-05", "2026-10-05", "must"),
      wants("Chris", "N", "2026-10-06", "2026-10-06", "never"),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(at(result.next, "Chris", "05")[0]).toMatchObject({ weight: Infinity });
    expect(at(result.next, "Chris", "06")[0]).toMatchObject({ weight: -Infinity });
  });

  it("cancels Ana's leave on 14 Oct and puts her on the night, in one change", () => {
    const result = applyAssistantCommands(octoberWard(), [
      clear("Ana", "2026-10-14"),
      wants("Ana", "N", "2026-10-14", "2026-10-14", "must"),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(at(result.next, "Ana", "14")).toEqual([
      { kind: "request", person: "Ana", date: "14", shiftType: "N", weight: Infinity },
    ]);
  });

  it("refuses a shift request that would only land on leave", () => {
    const result = applyAssistantCommand(
      octoberWard(),
      wants("Ana", "N", "2026-10-14", "2026-10-14", "must"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("no_effect");
    expect(result.rejection.message).toContain("never replaces leave or a day off");
    expect(result.rejection.message).toContain("clear those dates first");
  });

  it("removes one shift request with weight 0", () => {
    const result = applyAssistantCommand(
      octoberWard(),
      wants("Ben", "D", "2026-10-22", "2026-10-22", 0),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(at(result.next, "Ben", "22")).toEqual([]);
  });

  it("replaces leave with a day-off request, as painting OFF does", () => {
    const result = applyAssistantCommand(octoberWard(), off("Ana", "2026-10-14", "2026-10-14", 0));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(at(result.next, "Ana", "14")).toEqual([
        { kind: "off", person: "Ana", date: "14", weight: 0 },
      ]);
    }
  });

  it("accepts a staff group row, a shift group and ALL", () => {
    const result = applyAssistantCommands(octoberWard(), [
      wants("Seniors", "Nights", "2026-10-05", "2026-10-05", -3),
      wants("Ben", "ALL", "2026-10-01", "2026-10-03", 1),
    ]);
    expect(result.ok).toBe(true);
  });

  it("refuses unknown people, bad dates and dates outside the roster", () => {
    const withNumericId: ScenarioUiState = {
      ...octoberWard(),
      staff: [...octoberWard().staff, { id: 7 }],
    };
    const cases: [ScenarioUiState, Parameters<typeof applyAssistantCommand>[1], string, string][] =
      [
        [octoberWard(), leave("Dan", "2026-10-10"), "unknown_target", '"Dan"'],
        // Exact identity: the matrix never collapses 7 and "7".
        [withNumericId, leave("7", "2026-10-10"), "unknown_target", '"7"'],
        [
          octoberWard(),
          leave("Ana", "2026-10-30", "2026-11-02"),
          "unknown_target",
          "2026-10-01 to 2026-10-31",
        ],
        [octoberWard(), leave("Ana", "2026-10-16", "2026-10-10"), "invalid_value", "end date"],
        [octoberWard(), leave("Ana", "2026-10-32"), "invalid_value", "real calendar dates"],
        [
          { ...octoberWard(), rangeStart: "", rangeEnd: "" },
          leave("Ana", "2026-10-10"),
          "cascade_unavailable",
          "no roster period",
        ],
        [
          octoberWard(),
          wants("Ben", "OFF", "2026-10-19", "2026-10-19", 5),
          "invalid_value",
          "not a shift request",
        ],
        [octoberWard(), wants("Ben", "X", "2026-10-19", "2026-10-19", 5), "unknown_target", '"X"'],
      ];
    for (const [state, command, code, text] of cases) {
      const result = applyAssistantCommand(state, command);
      expect(result.ok, JSON.stringify(command)).toBe(false);
      if (result.ok) continue;
      expect(result.rejection.code, JSON.stringify(command)).toBe(code);
      expect(result.rejection.message).toContain(text);
    }
    expect(applyAssistantCommand(withNumericId, leave(7, "2026-10-10")).ok).toBe(true);
  });

  it("refuses a change that would change nothing, saying why", () => {
    const again = applyAssistantCommand(octoberWard(), leave("Ana", "2026-10-14"));
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.rejection.message).toContain("already on leave");
    const empty = applyAssistantCommand(octoberWard(), clear("Ana", "2026-10-01"));
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.rejection.message).toContain("nothing recorded");
  });
});
