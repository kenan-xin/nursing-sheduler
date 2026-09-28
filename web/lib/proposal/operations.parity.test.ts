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
import type { ScenarioUiState } from "@/lib/scenario";
import { saveShiftTypeCard } from "@/components/shift-types/save-shift-card";
import { shiftTypesDescriptor } from "@/components/shift-types/shift-types-descriptor";
import {
  addGroup,
  addItem,
  deleteGroup,
  deleteItem,
  paidMinutesFor,
  renameGroup,
  renameItem,
  setGroupMembers,
  updateGroupFields,
  validateFullEditId,
  validateWorkingTimeDraft,
  writeGroupMembers,
  writeItemGroups,
} from "@/components/entity-editor/core";
import type {
  AffinityCard,
  CountCard,
  CoveringCard,
  DateRef,
  PersonRef,
  SuccessionCard,
} from "@/lib/scenario";
import { peopleDescriptor } from "@/components/people/people-descriptor";
import { computeQuickPaintCellIntent } from "@/components/requests/requests-gestures";
import { createHotStore } from "@/lib/store/hot-store";
import { foldPaintIntents } from "@/lib/store/paint-fold";
import { applyAssistantCommand, assistantCellUids } from "./operations";
import {
  octoberWard,
  pairingWardScenario,
  peopleScenario,
  proposalScenario,
  ruleWardScenario,
} from "./test-support";
import {
  buildAffinityCard,
  validateAffinityForm,
  type AffinityFormState,
} from "@/components/affinities/affinities-model";
import {
  buildCoveringCard,
  validateCoveringForm,
  type CoveringFormState,
} from "@/components/coverings/coverings-model";
import { parseWeightInput } from "@/components/card-editor/weight-value";
import {
  buildSuccessionCard,
  validateSuccessionForm,
  type SuccessionFormState,
} from "@/components/successions/successions-model";
import {
  buildCountCard,
  buildCountShiftTypeDomain,
  countToForm,
  emptyCountForm,
  validateCountForm,
  type CountFormState,
} from "@/components/counts/counts-model";
import {
  buildRequirementCard,
  buildRequirementShiftTypeDomain,
  emptyRequirementForm,
  requirementCoveredIsos,
  requirementToForm,
  validateRequirementForm,
} from "@/components/requirements/requirements-model";
import { applyRequirementPatch } from "@/components/requirements/requirement-patch";
import {
  buildContractedCard,
  defaultContractedForm,
  hasContractedErrors,
  toContractedForm,
  validateContractedCommit,
  type ContractedFormState,
} from "@/components/counts/contracted-model";
import type { ContractedHoursCountCard } from "@/lib/scenario";
import { stableStringify } from "./digest";

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

describe("set_skill_mix is the Staffing requirements Edit form's skill mix rows", () => {
  // RN = ana, ben. "Day cover" needs 4 on Day.
  const skillMixWard = () => {
    const s = ruleWardScenario();
    s.cardsByKind.requirements[0] = { ...s.cardsByKind.requirements[0], requiredNumPeople: 4 };
    return s;
  };

  it.each([
    [[{ people: "RN", minNumPeople: 2 }]],
    [[{ people: "RN", minNumPeople: 9 }]], // above the head count: both refuse
    [
      [
        { people: "RN", minNumPeople: 1 },
        { people: "RN", minNumPeople: 2 },
      ],
    ], // duplicate: both refuse
  ])("assistant and form agree on %j", (skillMix) => {
    const state = skillMixWard();
    const domain = buildRequirementShiftTypeDomain(state);
    const draft = { ...requirementToForm(state.cardsByKind.requirements[0], domain), skillMix };
    const formErrors = validateRequirementForm(draft, domain);
    const manual =
      Object.keys(formErrors).length === 0
        ? applyRequirementPatch(state, { type: "update", uid: "req-day", form: draft })
        : null;
    const assistant = applyAssistantCommand(state, {
      type: "set_skill_mix",
      ruleId: "req-day",
      skillMix,
    });
    expect(assistant.ok).toBe(manual !== null);
    if (assistant.ok && manual) expect(assistant.next.cardsByKind).toEqual(manual.cardsByKind);
  });

  it("the Guided quick edit and set_staffing_requirement_people agree below the skill mix", () => {
    const state = skillMixWard();
    state.cardsByKind.requirements[0].skillMix = [{ people: "RN", minNumPeople: 2 }];
    const manual = applyRequirementQuickEdit(
      state.cardsByKind.requirements,
      "req-day",
      "requiredNumPeople",
      1,
    );
    const assistant = applyAssistantCommand(state, {
      type: "set_staffing_requirement_people",
      ruleId: "req-day",
      requiredNumPeople: 1,
    });
    expect(manual.kind).toBe("invalid-value");
    expect(assistant.ok).toBe(false);
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

describe("add_shift_type is the Shifts page's Add shift save", () => {
  // The value the working-time sub-form hands the grid, restated from `deriveValue`
  // in `working-time-fields.tsx:75-94`: rest 0 is absent, duration = paid minutes.
  const uiWorkingTime = (startTime: string, endTime: string, rest: number) => {
    const restMinutes = rest ? rest : undefined;
    return {
      startTime,
      endTime,
      restMinutes,
      durationMinutes: paidMinutesFor(startTime, endTime, restMinutes) ?? undefined,
    };
  };

  // The grid's own Save gate, restated from `shift-type-grid.tsx` (`canSave`).
  const gridCanSave = (
    state: ScenarioUiState,
    code: string,
    startTime: string,
    endTime: string,
    rest: number,
  ) => {
    const d = shiftTypesDescriptor;
    const idCheck = validateFullEditId(d, d.readItems(state), d.readGroups(state), code);
    const timeCheck = validateWorkingTimeDraft(uiWorkingTime(startTime, endTime, rest));
    return {
      ok: idCheck.ok && timeCheck.ok && !/^\d+$/.test(code.trim()),
      idCheck,
    };
  };

  /** Run the REAL manual save, capturing the document its single commit produces. */
  async function manualAdd(
    state: ScenarioUiState,
    code: string,
    name: string,
    startTime: string,
    endTime: string,
    rest: number,
  ): Promise<ScenarioUiState> {
    let next = state;
    await saveShiftTypeCard(
      async (updater) => {
        next = { ...state, ...updater(state) };
        return { ok: true };
      },
      {
        mode: "add",
        fields: {
          code,
          name,
          workingTime: uiWorkingTime(startTime, endTime, rest),
        },
        staffing: { type: "none" },
      },
    );
    return next;
  }

  // The Rest select only offers multiples of 30 up to span - 30; the off-list values
  // below check that the shared validator refuses them on both paths.
  const matrix: [code: string, name: string, start: string, end: string, rest: number][] = [
    ["am1", "Morning 1", "08:00", "15:00", 0],
    ["N", "Night shift", "20:00", "08:30", 60],
    ["  L  ", "", "08:00", "20:30", 30],
    ["Day", "", "08:00", "15:00", 0], // duplicate
    ["OFF", "", "08:00", "15:00", 0], // reserved
    ["123", "", "08:00", "15:00", 0], // numbers only
    ["x", "", "08:15", "15:00", 0], // off grid
    ["x", "", "08:00", "08:00", 0], // zero span
    ["", "", "08:00", "15:00", 0], // empty
    ["x", "", "08:00", "15:00", 45], // rest off the 30-minute grid
    ["x", "", "08:00", "10:00", 120], // rest = span
    ["x", "", "08:00", "15:00", -30], // negative rest
  ];

  it("accepts and refuses the same shifts, and produces the same document", async () => {
    const state = proposalScenario();
    for (const [code, name, startTime, endTime, rest] of matrix) {
      const gate = gridCanSave(state, code, startTime, endTime, rest);
      const assistant = applyAssistantCommand(state, {
        type: "add_shift_type",
        code,
        name,
        startTime,
        endTime,
        restMinutes: rest,
      });
      expect(assistant.ok, `grid ${gate.ok ? "accepts" : "refuses"} "${code}"`).toBe(gate.ok);
      if (gate.ok && gate.idCheck.ok && assistant.ok) {
        // The grid passes the TRIMMED id (`idCheck.id`) as the code.
        const manual = await manualAdd(state, gate.idCheck.id, name, startTime, endTime, rest);
        expect(assistant.next).toEqual(manual);
      }
    }
  });
});

describe("the Staff-screen arms are the Staff screen's saves", () => {
  const d = peopleDescriptor;

  // `people-table.tsx:723-745`: gate on validateFullEditId, then addItem + writeGroups.
  function manualAddPerson(state: ScenarioUiState, name: string, groups: string[]) {
    const check = validateFullEditId(d, d.readItems(state), d.readGroups(state), name);
    if (!check.ok) return null;
    return writeItemGroups(addItem(state, d, { id: check.id }), d, check.id, groups);
  }

  // `people-table.tsx:719-757`: rename only when the raw text changed, then writeGroups.
  function manualEditPerson(
    state: ScenarioUiState,
    personId: string | number,
    name: string,
    groups: string[],
  ) {
    const nameChanged = name !== String(personId);
    const check = nameChanged
      ? validateFullEditId(d, d.readItems(state), d.readGroups(state), name, false, personId)
      : ({ ok: true, id: name } as const);
    if (!check.ok) return null;
    const renamed = nameChanged ? renameItem(state, d, personId, check.id) : state;
    return writeItemGroups(renamed, d, nameChanged ? check.id : personId, groups);
  }

  it("add_person accepts, refuses and writes what Add nurse does", () => {
    const state = peopleScenario();
    for (const name of ["Cara", "  Cara  ", "12", "ana", "RN", "ALL", "all", ""]) {
      const manual = manualAddPerson(state, name, ["Seniors", "RN"]);
      const assistant = applyAssistantCommand(state, {
        type: "add_person",
        name,
        groups: ["Seniors", "RN"],
      });
      expect(assistant.ok, `"${name}"`).toBe(manual !== null);
      if (manual && assistant.ok) expect(assistant.next).toEqual(manual);
    }
  });

  it("edit_person accepts, refuses and writes what the row's Edit does", () => {
    const state = peopleScenario();
    const cases: [string | number, string, string[]][] = [
      ["ana", "Ana Lim", ["RN"]],
      ["ana", "ana", []],
      ["ana", "  ana  ", ["RN", "Seniors"]],
      [7, "7", ["Seniors"]],
      [7, " 7 ", ["RN"]], // the row renames number 7 to text "7"
      ["ana", "bo", ["RN"]],
      ["ana", "Seniors", ["RN"]],
      ["ana", "ALL", ["RN"]],
      ["ana", "", ["RN"]],
    ];
    for (const [personId, name, groups] of cases) {
      const manual = manualEditPerson(state, personId, name, groups);
      const assistant = applyAssistantCommand(state, {
        type: "edit_person",
        personId,
        name,
        groups,
      });
      expect(assistant.ok, `${String(personId)} -> "${name}"`).toBe(manual !== null);
      if (manual && assistant.ok) expect(assistant.next).toEqual(manual);
    }
  });

  it("remove_person is the row's Delete", () => {
    const state = peopleScenario();
    for (const personId of ["ana", "bo", 7] as const) {
      const assistant = applyAssistantCommand(state, {
        type: "remove_person",
        personId,
      });
      expect(assistant.ok).toBe(true);
      if (assistant.ok) expect(assistant.next).toEqual(deleteItem(state, d, personId));
    }
  });

  it("add_people_group accepts, refuses and writes what New group does", () => {
    const state = peopleScenario();
    // `groups-section.tsx:745-790` (add mode): addGroup(id, trimmed description) + writeGroupMembers.
    for (const groupId of ["Night team", "  Night team  ", "RN", "ana", "ALL", ""]) {
      const check = validateFullEditId(d, d.readItems(state), d.readGroups(state), groupId, true);
      const assistant = applyAssistantCommand(state, {
        type: "add_people_group",
        groupId,
        description: " Nights ",
        members: [7, "bo"],
      });
      expect(assistant.ok, `"${groupId}"`).toBe(check.ok);
      if (check.ok && assistant.ok) {
        const manual = writeGroupMembers(
          addGroup(state, d, { id: check.id, description: "Nights" }),
          d,
          check.id,
          [7, "bo"],
        );
        expect(assistant.next).toEqual(manual);
      }
    }
  });

  it("edit_people_group accepts, refuses and writes what the group's Edit does", () => {
    const state = peopleScenario();
    // `groups-section.tsx:741-790` (edit mode): rename if the text changed, then
    // updateGroupFields(trimmed description), then writeGroupMembers.
    for (const newGroupId of ["Registered nurses", "RN", "Seniors", "bo", "ALL", ""]) {
      const idChanged = newGroupId !== "RN";
      const check = idChanged
        ? validateFullEditId(d, d.readItems(state), d.readGroups(state), newGroupId, true, "RN")
        : ({ ok: true, id: "RN" } as const);
      const assistant = applyAssistantCommand(state, {
        type: "edit_people_group",
        groupId: "RN",
        newGroupId,
        description: " Registered ",
        members: ["bo", "ana"],
      });
      expect(assistant.ok, `"${newGroupId}"`).toBe(check.ok);
      if (check.ok && assistant.ok) {
        let manual = idChanged ? renameGroup(state, d, "RN", check.id) : state;
        manual = updateGroupFields(manual, d, check.id, {
          description: "Registered",
        });
        manual = writeGroupMembers(manual, d, check.id, ["bo", "ana"]);
        expect(assistant.next).toEqual(manual);
      }
    }
  });

  it("remove_people_group is the group's Delete", () => {
    const state = peopleScenario();
    const assistant = applyAssistantCommand(state, {
      type: "remove_people_group",
      groupId: "RN",
    });
    expect(assistant.ok).toBe(true);
    if (assistant.ok) expect(assistant.next).toEqual(deleteGroup(state, d, "RN"));
  });
});

describe("leave and request arms are the Requests page's quick paint", () => {
  /**
   * One real paint drag: the page's intent reducer per crossed cell, staged through
   * the real hot store, folded by the shared fold. The dispatch below restates the
   * private `stageCellIntent` in `use-requests.ts` (four calls, no logic of its own).
   * The minter is the host's, so the two documents can be compared exactly.
   */
  function manualPaint(
    state: ScenarioUiState,
    person: PersonRef,
    dates: DateRef[],
    selectedIds: string[],
    weight: number,
  ) {
    const hot = createHotStore();
    hot.getState().beginPaint();
    for (const date of dates) {
      const intent = computeQuickPaintCellIntent(selectedIds, weight);
      if (!intent) continue;
      if (intent.mode === "erase") hot.getState().stagePaintErase(person, date);
      else if (intent.mode === "day-state") {
        hot.getState().stagePaintDayState(person, date, intent.dayState);
      } else {
        for (const [selector, w] of intent.deltas) {
          hot.getState().stagePaintRequestDelta(person, date, selector, w);
        }
      }
    }
    const staged = hot.getState().paint;
    if (!staged) throw new Error("paint gesture did not open");
    return foldPaintIntents(state.reqData, staged, assistantCellUids(state.reqData));
  }

  const days = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => String(from + i).padStart(2, "0"));
  const iso = (day: number) => `2026-10-${String(day).padStart(2, "0")}`;

  // [assistant command, the paint selection a user would make, its weight, dates dragged]
  const matrix: [Parameters<typeof applyAssistantCommand>[1], string[], number, DateRef[]][] = [
    [
      {
        type: "add_leave",
        personId: "Ana",
        startDate: iso(10),
        endDate: iso(16),
      },
      ["LEAVE"],
      0,
      days(10, 16),
    ],
    [
      {
        type: "set_off_request",
        personId: "Ben",
        startDate: iso(21),
        endDate: iso(23),
        weight: -5,
      },
      ["OFF"],
      -5,
      days(21, 23),
    ],
    [
      {
        type: "set_off_request",
        personId: "Ana",
        startDate: iso(14),
        endDate: iso(14),
        weight: "must",
      },
      ["OFF"],
      Infinity,
      days(14, 14),
    ],
    [
      // Crosses Ben's day off on the 21st -- covers the precedence skip.
      {
        type: "set_shift_request",
        personId: "Ben",
        shiftType: "N",
        startDate: iso(19),
        endDate: iso(25),
        weight: -5,
      },
      ["N"],
      -5,
      days(19, 25),
    ],
    [
      {
        type: "set_shift_request",
        personId: "Ben",
        shiftType: "D",
        startDate: iso(22),
        endDate: iso(22),
        weight: 0,
      },
      ["D"],
      0,
      days(22, 22),
    ],
    [
      {
        type: "set_shift_request",
        personId: "Chris",
        shiftType: "L",
        startDate: iso(20),
        endDate: iso(20),
        weight: "never",
      },
      ["L"],
      -Infinity,
      days(20, 20),
    ],
    [
      {
        type: "set_shift_request",
        personId: "Seniors",
        shiftType: "Nights",
        startDate: iso(5),
        endDate: iso(5),
        weight: 3,
      },
      ["Nights"],
      3,
      days(5, 5),
    ],
    [
      {
        type: "set_shift_request",
        personId: "Ana",
        shiftType: "ALL",
        startDate: iso(1),
        endDate: iso(3),
        weight: 1,
      },
      ["ALL"],
      1,
      days(1, 3),
    ],
    [
      {
        type: "clear_requests",
        personId: "Ben",
        startDate: iso(21),
        endDate: iso(22),
      },
      [],
      0,
      days(21, 22),
    ],
  ];

  it("produces the same matrix as the paint gesture, cell for cell and uid for uid", () => {
    const state = octoberWard();
    for (const [command, selectedIds, weight, dates] of matrix) {
      const assistant = applyAssistantCommand(state, command);
      expect(assistant.ok, JSON.stringify(command)).toBe(true);
      if (!assistant.ok) continue;
      const personId = (command as { personId: PersonRef }).personId;
      expect(assistant.next.reqData, JSON.stringify(command)).toEqual(
        manualPaint(state, personId, dates, selectedIds, weight),
      );
    }
  });
});

describe("add_shift_group is the Groups New group save", () => {
  // `groups-section.tsx` save for a new group: `addGroup` then `writeGroupMembers`,
  // which for a brand-new group is `setGroupMembers` over live items.
  const withShifts = (): ScenarioUiState => ({
    ...proposalScenario(),
    shifts: [...proposalScenario().shifts, { id: "am1" }, { id: "am2" }],
  });

  it("accepts and refuses the same group ids, and produces the same document", () => {
    const state = withShifts();
    const d = shiftTypesDescriptor;
    for (const groupId of ["AM", "Day", "ALL", "", "  AM  "]) {
      const idCheck = validateFullEditId(d, d.readItems(state), d.readGroups(state), groupId, true);
      const assistant = applyAssistantCommand(state, {
        type: "add_shift_group",
        groupId,
        members: ["am2", "am1"],
      });
      expect(assistant.ok, `group "${groupId}"`).toBe(idCheck.ok);
      if (idCheck.ok && assistant.ok) {
        const manual = setGroupMembers(
          addGroup(state, d, { id: idCheck.id, description: undefined }),
          d,
          idCheck.id,
          ["am2", "am1"],
        );
        expect(assistant.next).toEqual(manual);
      }
    }
  });
});

// The editors' edit-save marker rule, restated from `use-successions.ts` / `use-counts.ts`
// `update` -- the one piece of the manual Save that lives in a hook, not a model.
function carryMarkers<T extends { disabled?: boolean; applied?: boolean }>(
  source: T,
  rebuilt: T,
): T {
  const markers: { disabled?: true; applied?: true } = {};
  if (source.disabled) markers.disabled = true;
  if (source.applied) markers.applied = true;
  return markers.disabled || markers.applied ? { ...rebuilt, ...markers } : rebuilt;
}

const valid = (errors: object) => Object.keys(errors).length === 0;

describe("succession arms are the Shift sequences form's Save", () => {
  const rows: {
    people: PersonRef[];
    pattern: string[];
    dates: string[];
    weight: string;
  }[] = [
    {
      people: ["ana", "ben", "cai"],
      pattern: ["Night", "Day"],
      dates: ["ALL"],
      weight: "-infinity",
    },
    {
      people: ["RN"],
      pattern: ["Night", "OFF", "Day"],
      dates: ["WEEKEND"],
      weight: "-50",
    },
    {
      people: ["ana"],
      pattern: ["Day", "Day"],
      dates: ["2026-04-06", "2026-04-07"],
      weight: "1k",
    },
    { people: ["ana"], pattern: ["Night"], dates: ["ALL"], weight: "-1" }, // one step
    { people: [], pattern: ["Night", "Day"], dates: ["ALL"], weight: "-1" }, // nobody
    { people: ["ana"], pattern: ["Night", "Day"], dates: [], weight: "-1" }, // no dates
    {
      people: ["ana"],
      pattern: ["Night", "Day"],
      dates: ["ALL"],
      weight: "strong",
    }, // bad weight
  ];
  const form = (row: (typeof rows)[number], description: string): SuccessionFormState => ({
    description,
    person: row.people,
    pattern: row.pattern,
    date: row.dates,
    weight: parseWeightInput(row.weight),
  });

  it("add: accepts and refuses what the form does, and appends the same card", () => {
    const state = ruleWardScenario();
    for (const [i, row] of rows.entries()) {
      const draft = form(row, `row ${i}`);
      const assistant = applyAssistantCommand(state, {
        type: "add_shift_sequence_rule",
        description: `row ${i}`,
        ...row,
      });
      expect(assistant.ok, `row ${i}`).toBe(valid(validateSuccessionForm(draft)));
      if (!assistant.ok) continue;
      const uid = assistant.next.cardsByKind.successions.at(-1)!.uid;
      // `use-successions.ts` add: append `buildSuccessionCard(form)`.
      expect(assistant.next).toEqual({
        ...state,
        cardsByKind: {
          ...state.cardsByKind,
          successions: [...state.cardsByKind.successions, buildSuccessionCard(draft, uid)],
        },
      });
    }
  });

  it("edit: rebuilds the card in place and keeps a switched-off rule off", () => {
    const state = ruleWardScenario();
    const source: SuccessionCard = {
      ...state.cardsByKind.successions[0],
      disabled: true,
    };
    state.cardsByKind.successions = [source];
    for (const [i, row] of rows.entries()) {
      const draft = form(row, "No day after night");
      const assistant = applyAssistantCommand(state, {
        type: "edit_shift_sequence_rule",
        ruleId: "suc-nd",
        description: "No day after night",
        ...row,
      });
      const manual = carryMarkers(source, buildSuccessionCard(draft, "suc-nd"));
      const changes = JSON.stringify(manual) !== JSON.stringify(source);
      expect(assistant.ok, `row ${i}`).toBe(valid(validateSuccessionForm(draft)) && changes);
      if (assistant.ok) expect(assistant.next.cardsByKind.successions).toEqual([manual]);
    }
  });
});

describe("count arms are the Shift counts form's Save", () => {
  const rows: {
    shiftTypes: string[];
    expression: "x <= T" | "x >= T" | "|x - T|^2";
    target: number;
    weight: string;
  }[] = [
    {
      shiftTypes: ["Night"],
      expression: "x <= T",
      target: 5,
      weight: "infinity",
    },
    {
      shiftTypes: ["Working shifts", "OFF"],
      expression: "x >= T",
      target: 3,
      weight: "10",
    },
    {
      shiftTypes: ["Night"],
      expression: "|x - T|^2",
      target: 8,
      weight: "-10",
    },
    {
      shiftTypes: ["Night"],
      expression: "|x - T|^2",
      target: 8,
      weight: "infinity",
    }, // squared + hard
    { shiftTypes: ["Night"], expression: "x <= T", target: 2.5, weight: "-1" }, // not whole
    { shiftTypes: [], expression: "x <= T", target: 5, weight: "-1" }, // nothing counted
  ];
  const draftOn = (base: CountFormState, row: (typeof rows)[number], description: string) => ({
    ...base,
    description,
    person: ["ana"] as PersonRef[],
    countDates: ["ALL"],
    countShiftTypes: row.shiftTypes,
    expression: row.expression,
    target: row.target,
    weight: parseWeightInput(row.weight),
  });

  it("add: accepts and refuses what the form does, and appends the same card", () => {
    const state = ruleWardScenario();
    const domain = buildCountShiftTypeDomain(state);
    for (const [i, row] of rows.entries()) {
      const draft = draftOn(emptyCountForm(), row, `row ${i}`);
      const assistant = applyAssistantCommand(state, {
        type: "add_count_rule",
        description: `row ${i}`,
        people: ["ana"],
        dates: ["ALL"],
        ...row,
      });
      expect(assistant.ok, `row ${i}`).toBe(valid(validateCountForm(draft, domain)));
      if (!assistant.ok) continue;
      const uid = assistant.next.cardsByKind.counts.at(-1)!.uid;
      expect(assistant.next.cardsByKind.counts).toEqual([
        ...state.cardsByKind.counts,
        buildCountCard(draft, domain, uid),
      ]);
    }
  });

  it("edit: starts from the loaded card, so coefficients and markers survive", () => {
    const state = ruleWardScenario();
    const source = {
      ...state.cardsByKind.counts[0],
      countShiftTypeCoefficients: [["Night", 2]],
      applied: true,
    } as CountCard;
    state.cardsByKind.counts = [source];
    const domain = buildCountShiftTypeDomain(state);
    for (const [i, row] of rows.entries()) {
      const draft = draftOn(countToForm(source, domain), row, "Night cap");
      const assistant = applyAssistantCommand(state, {
        type: "edit_count_rule",
        ruleId: "cnt-nights",
        description: "Night cap",
        people: ["ana"],
        dates: ["ALL"],
        ...row,
      });
      const ok = valid(validateCountForm(draft, domain));
      const manual = ok ? carryMarkers(source, buildCountCard(draft, domain, "cnt-nights")) : null;
      const changes = manual !== null && JSON.stringify(manual) !== JSON.stringify(source);
      expect(assistant.ok, `row ${i}`).toBe(ok && changes);
      if (assistant.ok) expect(assistant.next.cardsByKind.counts).toEqual([manual]);
    }
  });
});

describe("requirement arms are the Staffing requirements screen's commit", () => {
  const rows: {
    shiftType: string;
    qualifiedPeople: PersonRef[];
    dates: string[];
    requiredNumPeople: number;
  }[] = [
    {
      shiftType: "Night",
      qualifiedPeople: ["RN"],
      dates: ["ALL"],
      requiredNumPeople: 2,
    },
    {
      shiftType: "Working shifts",
      qualifiedPeople: ["Senior"],
      dates: ["ALL"],
      requiredNumPeople: 1,
    },
    {
      shiftType: "Day",
      qualifiedPeople: ["ALL"],
      dates: ["WEEKDAY"],
      requiredNumPeople: 0,
    },
    {
      shiftType: "Day",
      qualifiedPeople: ["RN"],
      dates: ["ALL"],
      requiredNumPeople: -1,
    }, // negative
    {
      shiftType: "Day",
      qualifiedPeople: [],
      dates: ["ALL"],
      requiredNumPeople: 1,
    }, // nobody
    {
      shiftType: "Day",
      qualifiedPeople: ["RN"],
      dates: ["ALL"],
      requiredNumPeople: 4,
    }, // above preferred (edit)
  ];

  it("add: accepts and refuses what the form does, and commits the same document", () => {
    const state = ruleWardScenario();
    const domain = buildRequirementShiftTypeDomain(state);
    for (const [i, row] of rows.entries()) {
      const form = {
        ...emptyRequirementForm(),
        description: `row ${i}`,
        shiftType: [row.shiftType],
        requiredNumPeople: row.requiredNumPeople,
        qualifiedPeople: row.qualifiedPeople,
        date: row.dates,
      };
      const assistant = applyAssistantCommand(state, {
        type: "add_staffing_requirement",
        description: `row ${i}`,
        ...row,
      });
      expect(assistant.ok, `row ${i}`).toBe(valid(validateRequirementForm(form, domain)));
      if (!assistant.ok) continue;
      const uid = assistant.next.cardsByKind.requirements.at(-1)!.uid;
      expect(assistant.next).toEqual(applyRequirementPatch(state, { type: "add", form, uid }));
    }
  });

  it("edit: starts from the loaded card and commits the same document", () => {
    const state = ruleWardScenario();
    state.cardsByKind.requirements[0] = {
      ...state.cardsByKind.requirements[0],
      preferredNumPeople: 3,
      weight: -50,
      disabled: true,
    };
    const source = state.cardsByKind.requirements[0];
    const domain = buildRequirementShiftTypeDomain(state);
    for (const [i, row] of rows.entries()) {
      const form = {
        ...requirementToForm(source, domain),
        description: "Day cover",
        shiftType: [row.shiftType],
        requiredNumPeople: row.requiredNumPeople,
        qualifiedPeople: row.qualifiedPeople,
        date: row.dates,
      };
      const assistant = applyAssistantCommand(state, {
        type: "edit_staffing_requirement",
        ruleId: "req-day",
        description: "Day cover",
        ...row,
      });
      expect(assistant.ok, `row ${i}`).toBe(valid(validateRequirementForm(form, domain)));
      if (assistant.ok) {
        expect(assistant.next).toEqual(
          applyRequirementPatch(state, {
            type: "update",
            uid: "req-day",
            form,
          }),
        );
      }
    }
  });
});

describe("a requirement's preferred count and weight are the form's (hg9v)", () => {
  const rows: { requiredNumPeople: number; preferredNumPeople?: number; weight?: string }[] = [
    { requiredNumPeople: 0, preferredNumPeople: 1, weight: "-50" }, // optional, ideally 1
    { requiredNumPeople: 2, preferredNumPeople: 3, weight: "-infinity" },
    { requiredNumPeople: 1, preferredNumPeople: 2 }, // the form's own weight
    { requiredNumPeople: 2, preferredNumPeople: 2, weight: "10" }, // equal: weight inert
    { requiredNumPeople: 2, preferredNumPeople: 1, weight: "-5" }, // below required
    { requiredNumPeople: 0, preferredNumPeople: 0, weight: "-5" }, // below 1
    { requiredNumPeople: 1, preferredNumPeople: 2, weight: "10" }, // positive
    { requiredNumPeople: 1, preferredNumPeople: 2, weight: "lots" }, // not a number
  ];
  const fields = {
    shiftType: "Day",
    qualifiedPeople: ["ALL"],
    dates: ["ALL"],
  };
  const withRow = <T extends { preferredNumPeople: unknown; weight: unknown }>(
    base: T,
    row: (typeof rows)[number],
  ) => ({
    ...base,
    requiredNumPeople: row.requiredNumPeople,
    ...(row.preferredNumPeople === undefined ? {} : { preferredNumPeople: row.preferredNumPeople }),
    ...(row.weight === undefined ? {} : { weight: parseWeightInput(row.weight) }),
  });

  it("add: accepts and refuses what the form does, and commits the same document", () => {
    const state = ruleWardScenario();
    const domain = buildRequirementShiftTypeDomain(state);
    for (const [i, row] of rows.entries()) {
      const form = withRow(
        {
          ...emptyRequirementForm(),
          description: `row ${i}`,
          shiftType: [fields.shiftType],
          qualifiedPeople: fields.qualifiedPeople,
          date: fields.dates,
        },
        row,
      );
      const assistant = applyAssistantCommand(state, {
        type: "add_staffing_requirement",
        description: `row ${i}`,
        ...fields,
        ...row,
      });
      expect(assistant.ok, `row ${i}`).toBe(valid(validateRequirementForm(form, domain)));
      if (!assistant.ok) continue;
      const uid = assistant.next.cardsByKind.requirements.at(-1)!.uid;
      expect(assistant.next).toEqual(applyRequirementPatch(state, { type: "add", form, uid }));
    }
  });

  it("edit: starts from the loaded card and commits the same document", () => {
    const state = ruleWardScenario();
    const source = state.cardsByKind.requirements[0];
    const domain = buildRequirementShiftTypeDomain(state);
    for (const [i, row] of rows.entries()) {
      const form = withRow(
        {
          ...requirementToForm(source, domain),
          description: "Day cover",
          shiftType: [fields.shiftType],
          qualifiedPeople: fields.qualifiedPeople,
          date: fields.dates,
        },
        row,
      );
      const assistant = applyAssistantCommand(state, {
        type: "edit_staffing_requirement",
        ruleId: "req-day",
        description: "Day cover",
        ...fields,
        ...row,
      });
      expect(assistant.ok, `row ${i}`).toBe(valid(validateRequirementForm(form, domain)));
      if (assistant.ok) {
        expect(assistant.next).toEqual(
          applyRequirementPatch(state, { type: "update", uid: "req-day", form }),
        );
      }
    }
  });

  it("optional, ideally 1 saves required 0 plus preferred 1, not an exact 0", () => {
    const assistant = applyAssistantCommand(ruleWardScenario(), {
      type: "add_staffing_requirement",
      description: "Second senior (optional, ideally 1)",
      ...fields,
      requiredNumPeople: 0,
      preferredNumPeople: 1,
      weight: "-50",
    });
    if (!assistant.ok) throw new Error(assistant.rejection.message);
    expect(assistant.next.cardsByKind.requirements.at(-1)).toMatchObject({
      requiredNumPeople: 0,
      preferredNumPeople: 1,
      weight: -50,
    });
  });
});

describe("set_staffing_requirement_on_date is the Edit form with one exception row", () => {
  const rows: [string, number][] = [
    ["2026-04-14", 1],
    ["2026-04-14", 0],
    ["2026-04-14", 2],
    ["2026-04-14", 3],
    ["2026-04-14", -1],
    ["2026-04-14", 1.5],
    ["2026-05-01", 1],
  ];

  it("accepts and refuses what the form does, and commits the same document", () => {
    // Canonicalise `req-day` first, to the card the Edit form itself would have written.
    // On a card an import left unnormalised, the arm deliberately writes only the
    // exception rows and leaves the rest of the card as it stands (bead e6n), so a
    // whole-card comparison is only meaningful against a form-written card.
    const fixture = ruleWardScenario();
    const fixtureDomain = buildRequirementShiftTypeDomain(fixture);
    const day = fixture.cardsByKind.requirements.find((c) => c.uid === "req-day")!;
    const canonical = buildRequirementCard(
      requirementToForm(day, fixtureDomain),
      fixtureDomain,
      "req-day",
    );
    const state: ScenarioUiState = {
      ...fixture,
      cardsByKind: {
        ...fixture.cardsByKind,
        requirements: fixture.cardsByKind.requirements.map((c) =>
          c.uid === "req-day" ? canonical : c,
        ),
      },
    };
    const source = state.cardsByKind.requirements.find((c) => c.uid === "req-day")!;
    const domain = buildRequirementShiftTypeDomain(state);
    for (const [i, [date, n]] of rows.entries()) {
      const base = requirementToForm(source, domain);
      const form = { ...base, requiredNumPeopleOverrides: [{ date, requiredNumPeople: n }] };
      const covered = new Set(requirementCoveredIsos(state, form.date));
      const manual = applyRequirementPatch(state, { type: "update", uid: "req-day", form });
      const formSaves =
        valid(validateRequirementForm(form, domain, covered)) &&
        stableStringify(manual) !== stableStringify(state);
      const assistant = applyAssistantCommand(state, {
        type: "set_staffing_requirement_on_date",
        ruleId: "req-day",
        date,
        requiredNumPeople: n,
      });
      expect(assistant.ok, `row ${i}`).toBe(formSaves);
      if (assistant.ok) expect(assistant.next).toEqual(manual);
    }
  });

  it("both refuse a multi-shift rule the same way", () => {
    const state = ruleWardScenario();
    const assistant = applyAssistantCommand(state, {
      type: "set_staffing_requirement_on_date",
      ruleId: "req-multi",
      date: "2026-04-14",
      requiredNumPeople: 1,
    });
    const source = state.cardsByKind.requirements.find((c) => c.uid === "req-multi")!;
    const domain = buildRequirementShiftTypeDomain(state);
    const form = {
      ...requirementToForm(source, domain),
      requiredNumPeopleOverrides: [{ date: "2026-04-14", requiredNumPeople: 1 }],
    };
    expect(assistant.ok).toBe(
      valid(
        validateRequirementForm(form, domain, new Set(requirementCoveredIsos(state, form.date))),
      ),
    );
  });
});

describe("remove_rule is every editor's Delete", () => {
  it("produces the list each editor's remove transform produces", () => {
    const state = ruleWardScenario();
    for (const [ruleKind, ruleId] of [
      ["requirements", "req-multi"],
      ["successions", "suc-nd"],
      ["counts", "cnt-nights"],
    ] as const) {
      const assistant = applyAssistantCommand(state, {
        type: "remove_rule",
        ruleKind,
        ruleId,
      });
      expect(assistant.ok, ruleKind).toBe(true);
      if (assistant.ok) {
        const cards = state.cardsByKind[ruleKind] as readonly { uid: string }[];
        expect(assistant.next.cardsByKind[ruleKind]).toEqual(
          cards.filter((card) => card.uid !== ruleId),
        );
      }
    }
  });
});

describe("pairing arms are the Affinities form's Save", () => {
  const rows: {
    people: PersonRef[];
    withPeople: PersonRef[];
    shiftTypes: string[];
    dates: string[];
    weight: string;
  }[] = [
    { people: ["ana"], withPeople: ["ben"], shiftTypes: ["Night"], dates: ["ALL"], weight: "-10" },
    {
      people: ["RN"],
      withPeople: ["Senior"],
      shiftTypes: ["Working shifts"],
      dates: ["WEEKEND"],
      weight: "5",
    },
    {
      people: ["ana"],
      withPeople: ["cai"],
      shiftTypes: ["OFF"],
      dates: ["2026-04-06", "2026-04-07"],
      weight: "-infinity",
    },
    { people: [], withPeople: ["ben"], shiftTypes: ["Night"], dates: ["ALL"], weight: "1" },
    { people: ["ana"], withPeople: [], shiftTypes: ["Night"], dates: ["ALL"], weight: "1" },
    { people: ["ana"], withPeople: ["ben"], shiftTypes: [], dates: ["ALL"], weight: "1" },
    { people: ["ana"], withPeople: ["ben"], shiftTypes: ["Night"], dates: [], weight: "1" },
    { people: ["ana"], withPeople: ["ben"], shiftTypes: ["Night"], dates: ["ALL"], weight: "x" },
  ];
  const form = (row: (typeof rows)[number], description: string): AffinityFormState => ({
    description,
    people1: row.people,
    people2: row.withPeople,
    shiftTypes: row.shiftTypes,
    date: row.dates,
    weight: parseWeightInput(row.weight),
  });

  it("add: accepts and refuses what the form does, and appends the same card", () => {
    const state = pairingWardScenario();
    for (const [i, row] of rows.entries()) {
      const draft = form(row, `row ${i}`);
      const assistant = applyAssistantCommand(state, {
        type: "add_pairing_rule",
        description: `row ${i}`,
        ...row,
      });
      expect(assistant.ok, `row ${i}`).toBe(valid(validateAffinityForm(draft)));
      if (!assistant.ok) continue;
      const uid = assistant.next.cardsByKind.affinities.at(-1)!.uid;
      // `use-affinities.ts` add: append `buildAffinityCard(form)`.
      expect(assistant.next).toEqual({
        ...state,
        cardsByKind: {
          ...state.cardsByKind,
          affinities: [...state.cardsByKind.affinities, buildAffinityCard(draft, uid)],
        },
      });
    }
  });

  it("edit: rebuilds the card in place and keeps a switched-off rule off", () => {
    const state = pairingWardScenario();
    const source: AffinityCard = { ...state.cardsByKind.affinities[0], disabled: true };
    state.cardsByKind.affinities = [source];
    for (const [i, row] of rows.entries()) {
      const draft = form(row, "Ana and Ben apart on nights");
      const assistant = applyAssistantCommand(state, {
        type: "edit_pairing_rule",
        ruleId: "aff-apart",
        description: "Ana and Ben apart on nights",
        ...row,
      });
      const manual = carryMarkers(source, buildAffinityCard(draft, "aff-apart"));
      const changes = stableStringify(manual) !== stableStringify(source);
      expect(assistant.ok, `row ${i}`).toBe(valid(validateAffinityForm(draft)) && changes);
      if (assistant.ok) expect(assistant.next.cardsByKind.affinities).toEqual([manual]);
    }
  });
});

describe("supervision arms are the Shift type coverings form's Save", () => {
  const rows: {
    supervisors: PersonRef[];
    supervisedPeople: PersonRef[];
    shiftTypes: string[];
    dates: string[];
  }[] = [
    { supervisors: ["Senior"], supervisedPeople: ["ben"], shiftTypes: ["Day"], dates: [] },
    {
      supervisors: ["cai"],
      supervisedPeople: ["RN"],
      shiftTypes: ["Working shifts"],
      dates: ["WEEKDAY"],
    },
    {
      supervisors: ["Senior"],
      supervisedPeople: ["ana", "ben"],
      shiftTypes: ["Night"],
      dates: ["2026-04-06"],
    },
    { supervisors: [], supervisedPeople: ["ben"], shiftTypes: ["Day"], dates: [] },
    { supervisors: ["Senior"], supervisedPeople: [], shiftTypes: ["Day"], dates: [] },
    { supervisors: ["Senior"], supervisedPeople: ["ben"], shiftTypes: [], dates: [] },
  ];
  const form = (row: (typeof rows)[number], description: string): CoveringFormState => ({
    description,
    preceptors: row.supervisors,
    preceptees: row.supervisedPeople,
    shiftTypes: row.shiftTypes,
    dates: row.dates,
  });

  it("add: accepts and refuses what the form does, and appends the same card", () => {
    const state = pairingWardScenario();
    for (const [i, row] of rows.entries()) {
      const draft = form(row, `row ${i}`);
      const assistant = applyAssistantCommand(state, {
        type: "add_supervision_rule",
        description: `row ${i}`,
        ...row,
      });
      expect(assistant.ok, `row ${i}`).toBe(valid(validateCoveringForm(draft, state)));
      if (!assistant.ok) continue;
      const uid = assistant.next.cardsByKind.coverings.at(-1)!.uid;
      // `use-coverings.ts` add: append `buildCoveringCard(form)`.
      expect(assistant.next).toEqual({
        ...state,
        cardsByKind: {
          ...state.cardsByKind,
          coverings: [...state.cardsByKind.coverings, buildCoveringCard(draft, uid)],
        },
      });
    }
  });

  it("edit: rebuilds the card in place and keeps its applied marker", () => {
    const state = pairingWardScenario();
    const source: CoveringCard = { ...state.cardsByKind.coverings[0], applied: true };
    state.cardsByKind.coverings = [source];
    for (const [i, row] of rows.entries()) {
      const draft = form(row, "Ben needs a senior on Day");
      const assistant = applyAssistantCommand(state, {
        type: "edit_supervision_rule",
        ruleId: "cov-ben",
        description: "Ben needs a senior on Day",
        ...row,
      });
      const manual = carryMarkers(source, buildCoveringCard(draft, "cov-ben"));
      const changes = stableStringify(manual) !== stableStringify(source);
      expect(assistant.ok, `row ${i}`).toBe(valid(validateCoveringForm(draft, state)) && changes);
      if (assistant.ok) expect(assistant.next.cardsByKind.coverings).toEqual([manual]);
    }
  });
});

describe("add_contracted_hours is the Contracted hours form's Save (4h5a)", () => {
  // Day 7.5 h, Night 10.5 h of working time, as the Shifts screen derives them.
  const timed = (): ScenarioUiState => {
    const state = ruleWardScenario();
    return {
      ...state,
      shifts: state.shifts.map((s) => ({ ...s, durationMinutes: s.id === "Night" ? 630 : 450 })),
    };
  };
  const rows: { minHours: number; maxHours: number; hoursPerShift?: number }[] = [
    { minHours: 160, maxHours: 160 }, // exact, each shift its own working time
    { minHours: 168, maxHours: 184, hoursPerShift: 8 }, // 21-23 days of 8 h
    { minHours: 150.5, maxHours: 170 },
    { minHours: 170, maxHours: 160 }, // minimum above maximum
    { minHours: 7.25, maxHours: 8 }, // off the half-hour grid
    { minHours: 160, maxHours: 176, hoursPerShift: 7.25 }, // shift credit off the grid
    { minHours: -8, maxHours: 8 }, // negative
  ];
  /** What the user types into the form opened by "Add Contracted Hours". */
  const typed = (state: ScenarioUiState, row: (typeof rows)[number]): ContractedFormState => {
    const base = defaultContractedForm(state);
    const exact = row.minHours === row.maxHours;
    return {
      ...base,
      description: "Contract",
      person: ["ana", "ben"],
      countDates: ["ALL"],
      policy: exact ? "exact" : "range",
      targetExact: exact ? `${row.minHours}h` : "",
      targetRangeMin: exact ? "" : `${row.minHours}h`,
      targetRangeMax: exact ? "" : `${row.maxHours}h`,
      countShiftTypeCoefficients:
        row.hoursPerShift === undefined
          ? base.countShiftTypeCoefficients
          : base.countShiftTypeCoefficients.map(([id]) => [id, row.hoursPerShift! * 2]),
    };
  };
  const command = (row: (typeof rows)[number]) => ({
    type: "add_contracted_hours" as const,
    description: "Contract",
    people: ["ana", "ben"],
    dates: ["ALL"],
    ...row,
  });

  it("accepts and refuses what the form does, and appends the same card", () => {
    for (const state of [timed(), ruleWardScenario()]) {
      for (const [i, row] of rows.entries()) {
        const form = typed(state, row);
        const assistant = applyAssistantCommand(state, command(row));
        expect(assistant.ok, `row ${i}`).toBe(
          !hasContractedErrors(validateContractedCommit(form, state)),
        );
        if (!assistant.ok) continue;
        const uid = assistant.next.cardsByKind.counts.at(-1)!.uid;
        expect(assistant.next.cardsByKind.counts).toEqual([
          ...state.cardsByKind.counts,
          buildContractedCard(form, state, uid),
        ]);
      }
    }
  });

  it("counts every day as the same hours when the contract is in days", () => {
    const result = applyAssistantCommand(timed(), command(rows[1]));
    if (!result.ok) throw new Error(result.rejection.message);
    expect(result.next.cardsByKind.counts.at(-1)).toMatchObject({
      tag: "contracted_hours",
      policy: "range",
      target: [336, 368],
      weight: Number.POSITIVE_INFINITY,
      countShiftTypeCoefficients: [
        ["Day", 16],
        ["Night", 16],
        ["LEAVE", 16],
      ],
    });
  });

  it("refuses a shift with no working time unless hoursPerShift is given", () => {
    const result = applyAssistantCommand(ruleWardScenario(), command(rows[0]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.message).toMatch(/hoursPerShift/);
  });

  it("refuses a person the People picker does not offer", () => {
    const result = applyAssistantCommand(timed(), { ...command(rows[1]), people: ["zed"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.code).toBe("unknown_target");
  });

  it("edit: starts from the loaded card (toContractedForm), keeps its uid and markers", () => {
    const added = applyAssistantCommand(timed(), command(rows[1]));
    if (!added.ok) throw new Error(added.rejection.message);
    const loaded = added.next.cardsByKind.counts.at(-1)!;
    const source = { ...loaded, disabled: true } as typeof loaded;
    const state = { ...added.next, cardsByKind: { ...added.next.cardsByKind, counts: [source] } };
    const edits = [
      { minHours: 152, maxHours: 184 }, // lower the floor, keep the 8 h days
      { minHours: 160, maxHours: 160, hoursPerShift: 8 },
      { minHours: 190, maxHours: 184 }, // minimum above maximum
      { minHours: 168, maxHours: 184 }, // no change
    ];
    for (const [i, row] of edits.entries()) {
      const base = toContractedForm(source as ContractedHoursCountCard, state);
      const exact = row.minHours === row.maxHours;
      const form: ContractedFormState = {
        ...base,
        description: "Contract",
        person: ["ana", "ben"],
        countDates: ["ALL"],
        policy: exact ? "exact" : "range",
        targetExact: exact ? `${row.minHours}h` : "",
        targetRangeMin: exact ? "" : `${row.minHours}h`,
        targetRangeMax: exact ? "" : `${row.maxHours}h`,
        countShiftTypeCoefficients:
          row.hoursPerShift === undefined
            ? base.countShiftTypeCoefficients
            : base.countShiftTypeCoefficients.map(([id]) => [id, row.hoursPerShift! * 2]),
      };
      const ok = !hasContractedErrors(validateContractedCommit(form, state));
      const manual = ok
        ? { ...buildContractedCard(form, state, source.uid), disabled: true }
        : null;
      const changes = manual !== null && JSON.stringify(manual) !== JSON.stringify(source);
      const assistant = applyAssistantCommand(state, {
        type: "edit_contracted_hours",
        ruleId: source.uid,
        description: "Contract",
        people: ["ana", "ben"],
        dates: ["ALL"],
        ...row,
      });
      expect(assistant.ok, `row ${i}`).toBe(ok && changes);
      if (assistant.ok) expect(assistant.next.cardsByKind.counts).toEqual([manual]);
    }
  });

  it("edit refuses a card that is not a contract, and edit_count_rule points to it", () => {
    const state = timed();
    const notContract = applyAssistantCommand(state, {
      type: "edit_contracted_hours",
      ruleId: "cnt-nights",
      description: "Contract",
      people: ["ana"],
      dates: ["ALL"],
      minHours: 150,
      maxHours: 160,
    });
    expect(notContract.ok).toBe(false);
    if (!notContract.ok) expect(notContract.rejection.code).toBe("unsupported_shape");

    const added = applyAssistantCommand(state, command(rows[1]));
    if (!added.ok) throw new Error(added.rejection.message);
    const asCount = applyAssistantCommand(added.next, {
      type: "edit_count_rule",
      ruleId: added.next.cardsByKind.counts.at(-1)!.uid,
      description: "Contract",
      people: ["ana"],
      shiftTypes: ["ALL"],
      dates: ["ALL"],
      expression: "x <= T",
      target: 5,
      weight: "infinity",
    });
    expect(asCount.ok).toBe(false);
    if (!asCount.ok) expect(asCount.rejection.message).toMatch(/edit_contracted_hours/);
  });
});
