// @vitest-environment jsdom
//
// MANUAL vs ASSISTANT VALIDATION PARITY (T07 acceptance).
//
// The ticket's first acceptance criterion is that manual and assistant preparation
// accept and reject the SAME supported operation. This suite is that proof, and it
// is deliberately written against the real manual code rather than a description of
// it: `applyRangeChange` is literally the function the Dates screen commits, and
// `toggleRequirementRule` / `applyRequirementQuickEdit` are literally the adapters
// the Guided Rules screen's toggle and Adjust control call.
//
// WHY THIS SUITE EXISTS AT ALL. `operations.ts` restates the rule predicates instead
// of importing those adapters, because the adapters reach the Guided mappers, which
// reach a `"use client"` React field component -- and the projection adapter imports
// `lib/proposal`, so that would put React in the durable scenario path. The
// restatement is only safe if something checks it, and this is that something: the
// parity is asserted over a matrix, in both directions, including the values each
// surface must REFUSE.
//
// jsdom because the manual adapters' import graph reaches React components.

import { describe, expect, it } from "vitest";
import { applyRangeChange } from "@/lib/dates";
import {
  applyRequirementQuickEdit,
  toggleRequirementRule,
} from "@/components/guided-rules/mutations";
import { requirementsMapper } from "@/components/guided-rules/mappers";
import { applyAssistantCommand } from "./operations";
import { proposalScenario } from "./test-support";

describe("set_roster_range is the manual range cascade", () => {
  it("produces the identical document the Dates screen commits", () => {
    const state = proposalScenario();
    for (const importPublicHolidays of [false, true]) {
      const manual = applyRangeChange(
        state,
        { start: "2026-04-05", end: "2026-04-20" },
        { importSingaporeHolidays: importPublicHolidays },
      );
      const assistant = applyAssistantCommand(state, {
        type: "set_roster_range",
        start: "2026-04-05",
        end: "2026-04-20",
        importPublicHolidays,
      });
      expect(assistant.ok).toBe(true);
      if (assistant.ok) expect(assistant.next).toEqual(manual);
    }
  });

  it("refuses exactly the ranges the manual card refuses to commit", () => {
    // The Roster period card holds an incomplete or backwards draft locally and
    // never runs the cascade on it (`invalid` / `!complete` in `roster-period-card`).
    const state = proposalScenario();
    for (const [start, end] of [
      ["2026-04-30", "2026-04-01"],
      ["2026-02-31", "2026-03-05"],
      ["not-a-date", "2026-04-30"],
    ]) {
      const assistant = applyAssistantCommand(state, {
        type: "set_roster_range",
        start,
        end,
        importPublicHolidays: false,
      });
      expect(assistant.ok, `${start}..${end}`).toBe(false);
    }
  });
});

describe("set_rule_enabled matches the Rules screen toggle", () => {
  it("produces the identical card for both directions", () => {
    let state = proposalScenario();

    for (const enabled of [false, true]) {
      const manual = toggleRequirementRule(state.cardsByKind.requirements, "req-day", enabled);
      const assistant = applyAssistantCommand(state, {
        type: "set_rule_enabled",
        ruleKind: "requirements",
        ruleId: "req-day",
        enabled,
      });

      if (manual.kind === "applied") {
        const alreadyThere =
          !state.cardsByKind.requirements.find((card) => card.uid === "req-day")?.disabled ===
          enabled;
        if (alreadyThere) {
          // The manual adapter has no "already true" arm -- the Rules screen renders
          // a switch, so the state is visible and the case cannot arise there. The
          // assistant CAN be asked for it, so it refuses rather than spending an Undo
          // entry on nothing. That is the one intended asymmetry, and it never makes
          // the assistant accept something manual refuses.
          expect(assistant.ok).toBe(false);
          continue;
        }
        expect(assistant.ok).toBe(true);
        if (assistant.ok) {
          expect(assistant.next.cardsByKind.requirements.find((c) => c.uid === "req-day")).toEqual(
            manual.card,
          );
          state = assistant.next;
        }
      }
    }
  });

  it("both refuse a rule that is not in the document", () => {
    const state = proposalScenario();
    expect(toggleRequirementRule(state.cardsByKind.requirements, "ghost", false).kind).toBe(
      "missing-source",
    );
    const assistant = applyAssistantCommand(state, {
      type: "set_rule_enabled",
      ruleKind: "requirements",
      ruleId: "ghost",
      enabled: false,
    });
    expect(assistant.ok).toBe(false);
  });
});

describe("set_staffing_requirement_people matches the Rules quick edit", () => {
  // The exact matrix each surface has to agree on. `2` is the card's current value
  // (the assistant's extra no-op refusal); everything else must land the same way.
  const values = [0, 1, 3, 10, -1, Number.NaN, Number.POSITIVE_INFINITY, 2.5];

  it("accepts and rejects the same values, and produces the same card", () => {
    const state = proposalScenario();
    for (const value of values) {
      const manual = applyRequirementQuickEdit(
        state.cardsByKind.requirements,
        "req-day",
        "requiredNumPeople",
        value,
      );
      const assistant = applyAssistantCommand(state, {
        type: "set_staffing_requirement_people",
        ruleId: "req-day",
        requiredNumPeople: value,
      });

      if (manual.kind === "applied") {
        expect(assistant.ok, `manual accepted ${value}`).toBe(true);
        if (assistant.ok) {
          expect(assistant.next.cardsByKind.requirements.find((c) => c.uid === "req-day")).toEqual(
            manual.card,
          );
        }
      } else {
        expect(assistant.ok, `manual rejected ${value} as ${manual.kind}`).toBe(false);
      }
    }
  });

  it("both treat a multi-target requirement as Advanced-only", () => {
    const state = proposalScenario();
    const multi = state.cardsByKind.requirements.find((card) => card.uid === "req-multi")!;
    // The manual surface expresses it by offering NO quick field for that card.
    expect(requirementsMapper.quickFields(multi)).toEqual([]);
    expect(requirementsMapper.unsupportedReason(multi)).toBeDefined();
    expect(
      applyRequirementQuickEdit(state.cardsByKind.requirements, "req-multi", "requiredNumPeople", 4)
        .kind,
    ).toBe("unsupported-field");

    const assistant = applyAssistantCommand(state, {
      type: "set_staffing_requirement_people",
      ruleId: "req-multi",
      requiredNumPeople: 4,
    });
    expect(assistant.ok).toBe(false);
    if (!assistant.ok) expect(assistant.rejection.code).toBe("unsupported_shape");
  });
});

describe("move_leave matches the manual cell contract", () => {
  it("produces what clearing the source and saving leave at the target produces", () => {
    const state = proposalScenario();

    // The manual path, written the way `use-requests.commitCellEdit` writes it: a
    // saved cell REPLACES its whole coordinate, reusing the existing `uid` for a
    // selector that was already there, and "Clear cell" drops the coordinate.
    const source = state.reqData.find((cell) => cell.person === "ana" && cell.date === "02")!;
    const cleared = state.reqData.filter((cell) => !(cell.person === "ana" && cell.date === "02"));
    const manual = [
      ...cleared.filter((cell) => !(cell.person === "ana" && cell.date === "10")),
      { kind: "leave" as const, person: "ana", date: "10", uid: source.uid },
    ];

    const assistant = applyAssistantCommand(state, {
      type: "move_leave",
      personId: "ana",
      fromDate: "02",
      toDate: "10",
    });
    expect(assistant.ok).toBe(true);
    if (assistant.ok) expect(assistant.next.reqData).toEqual(manual);
  });
});
