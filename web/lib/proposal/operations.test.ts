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
