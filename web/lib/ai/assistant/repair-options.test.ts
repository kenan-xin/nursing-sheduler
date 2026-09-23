import { describe, expect, it } from "vitest";
import { applyAssistantCommands } from "@/lib/proposal/operations";
import { deriveProposalDiff } from "@/lib/proposal/diff";
import { findStaffingShortfalls, type StaffingFinding } from "@/lib/rules/shortfalls";
import {
  SCENARIOS,
  cards,
  leave,
  nightCap,
  people,
  requirement,
  ward,
} from "@/lib/rules/ward-fixtures.test-support";
import type { ScenarioUiState } from "@/lib/scenario";
import {
  buildFeasibilityReport,
  classifySituation,
  explainFinding,
  isSafeOption,
  rankRepairOptions,
  type RepairOption,
  violatesSafetyFloor,
} from "./repair-options";

const rank = (state = SCENARIOS.onlyRnOnLeave(), runInfeasible = false) =>
  rankRepairOptions(state, findStaffingShortfalls(state), { runInfeasible });

const option = (partial: Partial<RepairOption>): RepairOption => ({
  repairId: "run_one_short",
  title: "t",
  why: "w",
  operations: [],
  confirmation: "manager",
  enforcedBy: "apply",
  confirmationQuestion: "q",
  needsFromUser: [],
  capabilityId: null,
  evidence: "static_check",
  ...partial,
});

type Op = RepairOption["operations"][number];

/** Every night needs exactly 1 on the ward, and exactly 2 RNs: the two cannot both hold. */
const conflictingNights = (outerSkillMix = false): ScenarioUiState =>
  ward({
    staff: people("ana", "ben", "cara"),
    staffGroups: [{ id: "RN", members: ["ana", "ben"] }],
    cardsByKind: cards({
      requirements: outerSkillMix
        ? [
            requirement("night-rn", "N", 1, { qualifiedPeople: ["RN"] }),
            requirement("night-total", "N", 2),
          ]
        : [
            requirement("night-total", "N", 1),
            requirement("night-rn", "N", 2, { qualifiedPeople: ["RN"] }),
          ],
    }),
  });

/** ruleTooStrict, but the night cap binds ALL, so a borrowed nurse would inherit it. */
const capOnAll = (): ScenarioUiState => {
  const base = SCENARIOS.ruleTooStrict();
  return {
    ...base,
    cardsByKind: { ...base.cardsByKind, counts: [nightCap("max-nights", "ALL", 1)] },
  };
};

describe("classifySituation", () => {
  const dated = (dateId: string): StaffingFinding => ({
    kind: "requirement_short",
    dateId,
    iso: null,
    shiftTypes: ["N"],
    ruleIds: ["r"],
    required: 1,
    available: 0,
    away: [],
    capRuleIds: [],
    skillMix: false,
  });
  it("orders capped over chronic over acute, and needs a failed run for unexplained", () => {
    expect(classifySituation([], false)).toBeNull();
    expect(classifySituation([], true)).toBe("unexplained");
    expect(classifySituation([dated("01")], false)).toBe("acute");
    expect(classifySituation(["01", "02", "03", "04"].map(dated), false)).toBe("chronic");
    expect(classifySituation([{ ...dated("01"), kind: "cap_short", dateId: null }], false)).toBe(
      "capped",
    );
  });
});

describe("rankRepairOptions", () => {
  it("returns nothing when there is nothing to fix", () => {
    expect(rank(SCENARIOS.empty())).toEqual([]);
  });

  it("offers at most three options, all safe", () => {
    for (const make of [...Object.values(SCENARIOS), () => conflictingNights(), capOnAll]) {
      const state = make();
      const options = rank(state, true);
      expect(options.length).toBeLessThanOrEqual(3);
      for (const o of options) expect(isSafeOption(state, o), o.repairId).toBe(true);
    }
  });

  it("every option applies on the real scenario, and the top one clears the static check", () => {
    const makers = { ...SCENARIOS, conflictingNights: () => conflictingNights(), capOnAll };
    for (const [name, make] of Object.entries(makers)) {
      const state = make();
      const options = rank(state, true);
      for (const o of options) {
        if (o.operations.length === 0) continue;
        const result = applyAssistantCommands(state, o.operations);
        expect(result.ok, `${name}/${o.repairId}: ${JSON.stringify(result)}`).toBe(true);
      }
      if (findStaffingShortfalls(state).length === 0) continue;
      const [top] = options;
      expect(top?.operations.length, name).toBeGreaterThan(0);
      const after = applyAssistantCommands(state, top.operations);
      if (!after.ok) throw new Error(name);
      expect(findStaffingShortfalls(after.next), `${name}/${top.repairId}`).toEqual([]);
    }
  });

  it("borrows a nurse in the needed group, off outside the loan and pinned to the short night", () => {
    const borrow = rank().find((o) => o.repairId === "borrow_temporary_nurse");
    expect(borrow).toMatchObject({ confirmation: "lending_ward", enforcedBy: "host_question" });
    const name = "Borrowed nurse 1";
    expect(borrow?.operations).toEqual([
      { type: "add_person", name, groups: ["RN"] },
      {
        type: "set_off_request",
        personId: name,
        startDate: "2026-11-01",
        endDate: "2026-11-02",
        weight: "must",
      },
      {
        type: "set_off_request",
        personId: name,
        startDate: "2026-11-04",
        endDate: "2026-11-07",
        weight: "must",
      },
      {
        type: "set_shift_request",
        personId: name,
        shiftType: "N",
        startDate: "2026-11-03",
        endDate: "2026-11-03",
        weight: "must",
      },
    ]);
  });

  it("picks a free placeholder name", () => {
    const base = SCENARIOS.onlyRnOnLeave();
    const state = { ...base, staff: [...base.staff, ...people("Borrowed nurse 1")] };
    const borrow = rank(state).find((o) => o.repairId === "borrow_temporary_nurse");
    expect(borrow?.operations[0]).toEqual({
      type: "add_person",
      name: "Borrowed nurse 2",
      groups: ["RN"],
    });
  });

  it("offers no borrow option when the skill group is unknown", () => {
    const base = SCENARIOS.onlyRnOnLeave();
    const state = {
      ...base,
      cardsByKind: {
        ...base.cardsByKind,
        requirements: base.cardsByKind.requirements.map((r) =>
          r.uid === "night-rn" ? { ...r, qualifiedPeople: ["rn1"] } : r,
        ),
      },
    };
    const ids = rank(state).map((o) => o.repairId);
    expect(ids).not.toContain("borrow_temporary_nurse");
    expect(ids).toContain("ask_nurse_on_leave");
  });

  it("narrows a hard count rule a borrowed nurse would inherit", () => {
    const borrow = rank(capOnAll()).find((o) => o.repairId === "borrow_temporary_nurse");
    expect(borrow?.operations).toContainEqual(
      expect.objectContaining({
        type: "edit_count_rule",
        ruleId: "max-nights",
        people: ["ana", "ben", "cara", "dev"],
        target: 1,
      }),
    );
  });

  it("tells the Preview that a narrowed rule will not cover nurses hired later", () => {
    const state = capOnAll();
    const borrow = rank(state).find((o) => o.repairId === "borrow_temporary_nurse");
    const applied = applyAssistantCommands(state, borrow!.operations);
    if (!applied.ok) throw new Error(applied.rejection.message);
    const diff = deriveProposalDiff(state, applied.next, borrow!.operations);
    expect(diff.cascade).toContainEqual(
      expect.objectContaining({
        key: "narrowed:max-nights",
        after: expect.stringMatching(/hired later/),
      }),
    );
  });

  it("offers no borrow option when a contracted-hours rule would bind the borrowed nurse", () => {
    const base = SCENARIOS.tooFewNurses();
    const state: ScenarioUiState = {
      ...base,
      cardsByKind: {
        ...base.cardsByKind,
        counts: [
          {
            ...nightCap("hours", "ALL", 40),
            countShiftTypes: ["ALL"],
            expression: "x >= T",
            tag: "contracted_hours",
            policy: "range",
          },
        ],
      },
    };
    expect(rank(state).map((o) => o.repairId)).not.toContain("borrow_temporary_nurse");
  });

  it("does not offer one-person fixes for a gap of two", () => {
    // With Ana on leave on the 5th, the night requirement alone is 1 short, but the day
    // (night 3 + day 1 from 2 free) is 2 short. The date-level gap must win.
    const base = SCENARIOS.understaffedNight();
    const state = { ...base, reqData: [leave("ana", "05")] };
    const options = rank(state);
    const ids = options.map((o) => o.repairId);
    expect(ids).not.toContain("ask_nurse_on_leave");
    expect(ids).not.toContain("run_one_short");
    const borrow = options.find((o) => o.repairId === "borrow_temporary_nurse");
    expect(borrow?.operations.filter((op) => op.type === "add_person")).toHaveLength(2);
  });

  it("never lowers a skill-mix requirement", () => {
    for (const o of rank(SCENARIOS.onlyRnOnLeave())) {
      for (const op of o.operations) {
        expect(op.type).not.toBe("set_staffing_requirement_people");
        expect(op.type).not.toBe("edit_staffing_requirement");
      }
    }
  });

  it("runs one short with ops only when the requirement targets that date alone", () => {
    const single = rank(SCENARIOS.understaffedNight()).find((o) => o.repairId === "run_one_short");
    expect(single?.operations).toEqual([
      { type: "set_staffing_requirement_people", ruleId: "night-05", requiredNumPeople: 2 },
    ]);
    const everyNight = ward({
      staff: people("ana", "ben", "cara"),
      cardsByKind: cards({
        requirements: [requirement("day", "D", 1), requirement("night", "N", 3)],
      }),
    });
    const advice = rank(everyNight).find((o) => o.repairId === "run_one_short");
    expect(advice).toMatchObject({ operations: [], capabilityId: "staffing-requirements" });
  });

  it("refuses a cap raise above the limit", () => {
    const base = SCENARIOS.ruleTooStrict();
    const state = {
      ...base,
      cardsByKind: {
        ...base.cardsByKind,
        requirements: base.cardsByKind.requirements.map((r) =>
          r.uid === "night" ? { ...r, requiredNumPeople: 3 } : r,
        ),
      },
    };
    // 21 nights for 4 nurses capped at 1 each: +5 per nurse, above MAX_CAP_RAISE.
    expect(rank(state).map((o) => o.repairId)).not.toContain("relax_count_rule");
  });

  it("keeps a generated cap label true after a raise, and never rewrites the manager's own label", () => {
    const relaxed = (description: string) => {
      const base = SCENARIOS.ruleTooStrict();
      const [card] = base.cardsByKind.counts;
      const state = {
        ...base,
        cardsByKind: { ...base.cardsByKind, counts: [{ ...card, description }] },
      };
      const relax = rank(state).find((o) => o.repairId === "relax_count_rule");
      expect(relax && isSafeOption(state, relax)).toBe(true);
      return relax?.operations[0];
    };
    expect(relaxed("At most 1 nights")).toMatchObject({
      target: 2,
      description: "At most 2 nights",
    });
    expect(relaxed("Night limit agreed with the union")).toMatchObject({
      description: "Night limit agreed with the union",
    });
    // The number is not the current cap, so the label is the manager's, not generated.
    expect(relaxed("At most 10 nights a month")).toMatchObject({
      description: "At most 10 nights a month",
    });
  });

  it("aligns conflicting requirements by raising the wider one, never a skill-mix one", () => {
    const [top] = rank(conflictingNights());
    expect(top).toMatchObject({
      repairId: "align_overlapping_requirements",
      operations: [
        { type: "set_staffing_requirement_people", ruleId: "night-total", requiredNumPeople: 2 },
      ],
    });
    const options = rank(conflictingNights(true));
    const align = options.find((o) => o.repairId === "align_overlapping_requirements");
    expect(align).toMatchObject({ operations: [], capabilityId: "staffing-requirements" });
    for (const o of options) {
      for (const op of o.operations) expect("ruleId" in op && op.ruleId).not.toBe("night-rn");
    }
  });
});

describe("isSafeOption", () => {
  const rn = SCENARIOS.onlyRnOnLeave();
  const capped = SCENARIOS.ruleTooStrict();
  const lowered = ward({
    staff: people("ana", "ben"),
    cardsByKind: cards({
      requirements: [
        requirement("day", "D", 2),
        requirement("night-05", "N", 2, { date: ["2026-11-05"] }),
      ],
    }),
  });
  const editCap = (patch: Record<string, unknown>) => ({
    type: "edit_count_rule",
    ruleId: "max-nights",
    description: `At most ${String(patch.target ?? 2)} nights`,
    people: ["Nurses"],
    shiftTypes: ["N"],
    dates: ["ALL"],
    expression: "x <= T",
    target: 2,
    weight: "infinity",
    ...patch,
  });
  const borrowed = { type: "add_person", name: "Borrowed nurse 1", groups: ["RN"] };
  const loan = { confirmation: "lending_ward", enforcedBy: "host_question" } as const;
  const nurse = { confirmation: "named_nurse", enforcedBy: "host_question" } as const;
  const clear = {
    type: "clear_requests",
    personId: "rn1",
    startDate: "2026-11-03",
    endDate: "2026-11-03",
  };

  // One or more unsafe shapes per SAFETY_FLOOR line, in its order.
  const UNSAFE: [string, ScenarioUiState, Partial<RepairOption>][] = [
    // Rest rules.
    [
      "rest rule off",
      rn,
      {
        operations: [
          { type: "set_rule_enabled", ruleKind: "successions", ruleId: "x", enabled: false },
        ] as Op[],
      },
    ],
    [
      "rest rule removed",
      rn,
      { operations: [{ type: "remove_rule", ruleKind: "successions", ruleId: "x" }] as Op[] },
    ],
    [
      "rest rule softened",
      rn,
      {
        operations: [
          {
            type: "edit_succession_rule",
            ruleId: "x",
            description: "",
            people: ["ALL"],
            pattern: ["N", "D"],
            dates: ["ALL"],
            weight: "-10",
          },
        ] as Op[],
      },
    ],
    [
      "rest rule added",
      rn,
      {
        operations: [
          {
            type: "add_succession_rule",
            description: "",
            people: ["rn1"],
            pattern: ["N", "D"],
            dates: ["ALL"],
            weight: "-infinity",
          },
        ] as Op[],
      },
    ],
    // Supervision rules.
    [
      "supervision off",
      rn,
      {
        operations: [
          { type: "set_rule_enabled", ruleKind: "coverings", ruleId: "x", enabled: false },
        ] as Op[],
      },
    ],
    [
      "supervision removed",
      rn,
      { operations: [{ type: "remove_rule", ruleKind: "coverings", ruleId: "x" }] as Op[] },
    ],
    // Skill mix: never lowered, never created.
    [
      "skill mix to 0",
      rn,
      {
        operations: [
          { type: "set_staffing_requirement_people", ruleId: "night-rn", requiredNumPeople: 0 },
        ] as Op[],
      },
    ],
    [
      "skill mix edited",
      rn,
      {
        operations: [
          {
            type: "edit_staffing_requirement",
            ruleId: "night-rn",
            description: "",
            shiftType: "N",
            qualifiedPeople: ["ALL"],
            dates: ["ALL"],
            requiredNumPeople: 1,
          },
        ] as Op[],
      },
    ],
    [
      "skill mix created",
      rn,
      {
        operations: [
          {
            type: "add_staffing_requirement",
            description: "",
            shiftType: "D",
            qualifiedPeople: ["RN"],
            dates: ["ALL"],
            requiredNumPeople: 1,
          },
        ] as Op[],
      },
    ],
    // Zero or off.
    [
      "requirement to 0",
      rn,
      {
        operations: [
          { type: "set_staffing_requirement_people", ruleId: "day", requiredNumPeople: 0 },
        ] as Op[],
      },
    ],
    [
      "requirement off",
      rn,
      {
        operations: [
          { type: "set_rule_enabled", ruleKind: "requirements", ruleId: "day", enabled: false },
        ] as Op[],
      },
    ],
    [
      "requirement removed",
      rn,
      { operations: [{ type: "remove_rule", ruleKind: "requirements", ruleId: "day" }] as Op[] },
    ],
    [
      "lowered on every day",
      lowered,
      {
        operations: [
          { type: "set_staffing_requirement_people", ruleId: "day", requiredNumPeople: 1 },
        ] as Op[],
      },
    ],
    // Limits: at most +2, same expression and hard weight, never removed.
    ["cap +3", capped, { operations: [editCap({ target: 4 })] as Op[] }],
    ["cap expression changed", capped, { operations: [editCap({ expression: "x >= T" })] as Op[] }],
    ["cap made soft", capped, { operations: [editCap({ weight: "10" })] as Op[] }],
    [
      "cap narrowed with nobody borrowed",
      capped,
      { operations: [editCap({ target: 1, people: ["ana", "ben", "cara"] })] as Op[] },
    ],
    [
      "cap removed",
      capped,
      { operations: [{ type: "remove_rule", ruleKind: "counts", ruleId: "max-nights" }] as Op[] },
    ],
    [
      "cap off",
      capped,
      {
        operations: [
          { type: "set_rule_enabled", ruleKind: "counts", ruleId: "max-nights", enabled: false },
        ] as Op[],
      },
    ],
    // Leave: only with the nurse's host-asked agreement.
    ["leave cleared by the manager", rn, { operations: [clear] as Op[] }],
    [
      "leave cleared in chat",
      rn,
      { operations: [clear] as Op[], confirmation: "named_nurse", enforcedBy: "chat" },
    ],
    [
      "leave moved by the manager",
      rn,
      {
        operations: [{ type: "move_leave", personId: "rn1", fromDate: "03", toDate: "04" }] as Op[],
      },
    ],
    [
      "leave painted over",
      rn,
      {
        ...loan,
        operations: [
          {
            type: "set_off_request",
            personId: "rn1",
            startDate: "2026-11-03",
            endDate: "2026-11-03",
            weight: "must",
          },
        ] as Op[],
      },
    ],
    // Borrowed nurse in a skill group without a host-asked confirmation.
    [
      "skilled borrow in chat",
      rn,
      { operations: [borrowed] as Op[], confirmation: "lending_ward", enforcedBy: "chat" },
    ],
    [
      "borrow on the manager's word",
      rn,
      { operations: [borrowed] as Op[], confirmation: "manager", enforcedBy: "host_question" },
    ],
    // Invented names.
    [
      "invented new nurse",
      rn,
      { ...loan, operations: [{ type: "add_person", name: "Sarah Lee", groups: [] }] as Op[] },
    ],
    [
      "invented request target",
      rn,
      {
        operations: [
          {
            type: "set_shift_request",
            personId: "ghost",
            shiftType: "N",
            startDate: "2026-11-03",
            endDate: "2026-11-03",
            weight: 10,
          },
        ] as Op[],
      },
    ],
    [
      "pinned someone not added",
      rn,
      {
        ...loan,
        operations: [
          {
            type: "set_off_request",
            personId: "Borrowed nurse 9",
            startDate: "2026-11-01",
            endDate: "2026-11-02",
            weight: "must",
          },
        ] as Op[],
      },
    ],
  ];

  it.each(UNSAFE)("refuses %s", (_label, state, partial) => {
    expect(isSafeOption(state, option(partial))).toBe(false);
  });

  const SAFE: [string, ScenarioUiState, Partial<RepairOption>][] = [
    [
      "leave cleared with the nurse's host-asked agreement",
      rn,
      { ...nurse, operations: [clear] as Op[] },
    ],
    ["cap +2", capped, { operations: [editCap({ target: 3 })] as Op[] }],
    [
      "one short on a single-date requirement",
      lowered,
      {
        operations: [
          { type: "set_staffing_requirement_people", ruleId: "night-05", requiredNumPeople: 1 },
        ] as Op[],
      },
    ],
    [
      "a softened request",
      rn,
      {
        operations: [
          {
            type: "set_shift_request",
            personId: "rn1",
            shiftType: "N",
            startDate: "2026-11-03",
            endDate: "2026-11-03",
            weight: -10,
          },
        ] as Op[],
      },
    ],
    [
      "a bounded skilled loan",
      rn,
      {
        ...loan,
        operations: [
          borrowed,
          {
            type: "set_off_request",
            personId: "Borrowed nurse 1",
            startDate: "2026-11-01",
            endDate: "2026-11-02",
            weight: "must",
          },
          {
            type: "set_shift_request",
            personId: "Borrowed nurse 1",
            shiftType: "N",
            startDate: "2026-11-03",
            endDate: "2026-11-03",
            weight: "must",
          },
        ] as Op[],
      },
    ],
  ];

  it.each(SAFE)("accepts %s", (_label, state, partial) => {
    expect(isSafeOption(state, option(partial))).toBe(true);
  });
});

describe("review fixes (2026-09-24)", () => {
  const allDays = (person: string) =>
    ["01", "02", "03", "04", "05", "06", "07"].map((d) => leave(person, d));

  it("runs one short only on a requirement in every finding that day", () => {
    // The RN night is the real gap; day-03 appears only in the day-level finding.
    const base = SCENARIOS.onlyRnOnLeave();
    const state = {
      ...base,
      cardsByKind: {
        ...base.cardsByKind,
        requirements: [
          ...base.cardsByKind.requirements.filter((r) => r.uid !== "day"),
          requirement("day-03", "D", 2, { date: ["2026-11-03"] }),
        ],
      },
    };
    const findings = findStaffingShortfalls(state);
    expect(findings.map((f) => f.kind)).toEqual(["requirement_short", "day_short"]);
    expect(rank(state).map((o) => o.repairId)).not.toContain("run_one_short");
  });

  it("asks a nurse on leave only when she is away in every finding that day", () => {
    const state = SCENARIOS.onlyRnOnLeave();
    const [nightShort] = findStaffingShortfalls(state);
    const dayShort: StaffingFinding = {
      ...nightShort,
      shiftTypes: ["D"],
      ruleIds: ["day"],
      away: [],
      skillMix: false,
    };
    const ids = rankRepairOptions(state, [nightShort, dayShort], { runInfeasible: false }).map(
      (o) => o.repairId,
    );
    expect(ids).not.toContain("ask_nurse_on_leave");
  });

  it("does not raise the wider requirement when the inner number varies by date", () => {
    const state = ward({
      staff: people("ana", "ben", "cara"),
      staffGroups: [{ id: "RN", members: ["ana", "ben", "cara"] }],
      cardsByKind: cards({
        requirements: [
          requirement("night-total", "N", 1),
          requirement("rn-weekday", "N", 2, { qualifiedPeople: ["RN"], date: ["WEEKDAY"] }),
          requirement("rn-weekend", "N", 3, { qualifiedPeople: ["RN"], date: ["WEEKEND"] }),
        ],
      }),
    });
    const align = rank(state).find((o) => o.repairId === "align_overlapping_requirements");
    expect(align?.operations).toEqual([]);
  });

  it("sizes a capped loan by the dates the requirement covers", () => {
    const base = SCENARIOS.ruleTooStrict();
    const state = {
      ...base,
      cardsByKind: {
        ...base.cardsByKind,
        requirements: [requirement("night-05", "N", 3, { date: ["2026-11-05"] })],
        counts: [nightCap("max-nights", "Nurses", 0)],
      },
    };
    const borrow = rank(state).find((o) => o.repairId === "borrow_temporary_nurse");
    expect(borrow?.operations.filter((op) => op.type === "add_person")).toHaveLength(3);
  });

  it("does not raise a cap for nurses who are away anyway", () => {
    // ana and ben are on leave all week: only cara and dev can use a higher cap.
    const state = { ...SCENARIOS.ruleTooStrict(), reqData: [...allDays("ana"), ...allDays("ben")] };
    expect(rank(state).map((o) => o.repairId)).not.toContain("relax_count_rule");
  });

  it("softens a hard request only when that alone closes the gap", () => {
    const never = (person: string) => ({
      uid: `never-${person}`,
      person,
      date: "03",
      kind: "request" as const,
      shiftType: "N",
      weight: -Infinity,
    });
    const one = { ...SCENARIOS.onlyRnOnLeave(), reqData: [never("rn1")] };
    expect(rank(one).map((o) => o.repairId)).toContain("soften_hard_request");
    const base = SCENARIOS.onlyRnOnLeave();
    const two = {
      ...base,
      staff: [...base.staff, ...people("rn2")],
      staffGroups: [{ id: "RN", members: ["rn1", "rn2"] }],
      reqData: [never("rn1"), never("rn2")],
      cardsByKind: {
        ...base.cardsByKind,
        requirements: base.cardsByKind.requirements.map((r) =>
          r.uid === "night-rn" ? { ...r, requiredNumPeople: 2 } : r,
        ),
      },
    };
    expect(rank(two).map((o) => o.repairId)).not.toContain("soften_hard_request");
  });

  it("books a borrowed nurse only on the short dates, off on every day between them", () => {
    const state = ward({
      staff: people("ana", "ben", "cara"),
      cardsByKind: cards({
        requirements: [
          requirement("day", "D", 1),
          requirement("night", "N", 1, {
            date: ["2026-11-01", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-07"],
          }),
          requirement("night-busy", "N", 3, { date: ["2026-11-02", "2026-11-06"] }),
        ],
      }),
    });
    const borrow = rank(state).find((o) => o.repairId === "borrow_temporary_nurse");
    const off = borrow?.operations.filter((op) => op.type === "set_off_request");
    expect(off?.map((op) => [op.startDate, op.endDate])).toEqual([
      ["2026-11-01", "2026-11-01"],
      ["2026-11-03", "2026-11-05"],
      ["2026-11-07", "2026-11-07"],
    ]);
    expect(borrow?.title).toMatch(/Nov 2, 2026 and .*Nov 6, 2026$/);
    expect(borrow?.confirmationQuestion).toMatch(/Nov 2, 2026 and .*Nov 6, 2026\?$/);
  });

  it("asks a nurse for one extra shift only when one shift closes the gap", () => {
    const base = SCENARIOS.personalCapsTooLow();
    const state = {
      ...base,
      cardsByKind: {
        ...base.cardsByKind,
        counts: [nightCap("ana-nights", "ana", 2), nightCap("ben-nights", "ben", 2)],
      },
    };
    expect(rank(state).map((o) => o.repairId)).not.toContain("extra_shift_willing_nurse");
  });

  it("softens a hard day off to a strong wish, asked of the nurse in chat", () => {
    const base = SCENARIOS.onlyRnOnLeave();
    const state: ScenarioUiState = {
      ...base,
      reqData: [{ uid: "off-rn1", person: "rn1", date: "03", kind: "off", weight: Infinity }],
    };
    const soften = rank(state).find((o) => o.repairId === "soften_hard_request");
    expect(soften).toMatchObject({ confirmation: "named_nurse", enforcedBy: "chat" });
    expect(soften?.operations).toEqual([
      {
        type: "set_off_request",
        personId: "rn1",
        startDate: "2026-11-03",
        endDate: "2026-11-03",
        weight: 10,
      },
    ]);
    expect(soften && isSafeOption(state, soften)).toBe(true);
    const after = applyAssistantCommands(state, soften!.operations);
    if (!after.ok) throw new Error(after.rejection.message);
    expect(findStaffingShortfalls(after.next)).toEqual([]);
  });

  it("softens the hard request on a date one nurse can fix, not the first one found", () => {
    const never = (person: string, date: string) => ({
      uid: `never-${person}-${date}`,
      person,
      date,
      kind: "request" as const,
      shiftType: "N",
      weight: -Infinity,
    });
    const state = ward({
      staff: people("ana", "ben", "cara"),
      reqData: [
        never("ana", "02"),
        never("ben", "02"),
        never("ana", "04"),
        never("ben", "04"),
        never("cara", "04"),
      ],
      cardsByKind: cards({
        requirements: [
          requirement("night", "N", 1, {
            date: [
              "2026-11-01",
              "2026-11-03",
              "2026-11-04",
              "2026-11-05",
              "2026-11-06",
              "2026-11-07",
            ],
          }),
          requirement("night-02", "N", 3, { date: ["2026-11-02"] }),
        ],
      }),
    });
    const soften = rank(state).find((o) => o.repairId === "soften_hard_request");
    expect(soften?.operations).toEqual([
      expect.objectContaining({ type: "set_shift_request", startDate: "2026-11-04" }),
    ]);
  });

  it("offers no borrow when the gap is above MAX_BORROWED", () => {
    const state = ward({
      staff: people("ana"),
      cardsByKind: cards({
        requirements: [requirement("night-05", "N", 5, { date: ["2026-11-05"] })],
      }),
    });
    expect(rank(state).map((o) => o.repairId)).not.toContain("borrow_temporary_nurse");
  });

  it("isSafeOption refuses a lowered skill mix, duplicate narrowing and too many borrowed", () => {
    const rn = {
      ...SCENARIOS.onlyRnOnLeave(),
      staffGroups: [{ id: "RN", members: ["rn1", "en1"] }],
    };
    const twoRn = {
      ...rn,
      cardsByKind: {
        ...rn.cardsByKind,
        requirements: rn.cardsByKind.requirements.map((r) =>
          r.uid === "night-rn" ? { ...r, requiredNumPeople: 2, date: ["2026-11-03"] } : r,
        ),
      },
    };
    expect(
      isSafeOption(
        twoRn,
        option({
          operations: [
            { type: "set_staffing_requirement_people", ruleId: "night-rn", requiredNumPeople: 1 },
          ],
        }),
      ),
    ).toBe(false);

    const loan = { confirmation: "lending_ward", enforcedBy: "host_question" } as const;
    const add = (n: number) => ({
      type: "add_person" as const,
      name: `Borrowed nurse ${n}`,
      groups: [],
    });
    const narrow = {
      type: "edit_count_rule" as const,
      ruleId: "max-nights",
      description: "At most 1 nights",
      people: ["ana", "ana", "ben", "cara"],
      shiftTypes: ["N"],
      dates: ["ALL"],
      expression: "x <= T" as const,
      target: 1,
      weight: "infinity",
    };
    const capped = SCENARIOS.ruleTooStrict();
    expect(isSafeOption(capped, option({ ...loan, operations: [add(1), narrow] }))).toBe(false);
    expect(
      isSafeOption(
        capped,
        option({
          ...loan,
          operations: [add(1), { ...narrow, people: ["ana", "ben", "cara", "dev"] }],
        }),
      ),
    ).toBe(true);
    expect(isSafeOption(capped, option({ ...loan, operations: [1, 2, 3, 4].map(add) }))).toBe(
      false,
    );
    expect(isSafeOption(capped, option({ ...loan, operations: [1, 2, 3].map(add) }))).toBe(true);
  });
});

describe("explaining in ward language", () => {
  it("names the day, shift, numbers and who is away", () => {
    const state = SCENARIOS.onlyRnOnLeave();
    const [finding] = findStaffingShortfalls(state);
    expect(explainFinding(state, finding)).toBe(
      "Tuesday, Nov 3, 2026, N: needs 1 from its group, only 0 free. Away: rn1 (on leave).",
    );
  });

  it("names both sides of a requirement conflict", () => {
    const state = conflictingNights();
    const [finding] = findStaffingShortfalls(state);
    expect(explainFinding(state, finding)).toBe(
      'Sunday, Nov 1, 2026, N: night-rn need 2 in total, but "night-total" allows at most 1.',
    );
  });

  it("builds a report that caps findings and says how certain it is", () => {
    const report = buildFeasibilityReport(SCENARIOS.tooFewNurses(), false);
    expect(report.findings).toHaveLength(5);
    expect(report.moreFindings).toBe(2);
    expect(report.certainty).toMatch(/certain/);
    const unexplained = buildFeasibilityReport(SCENARIOS.restRuleTooTight(), true);
    expect(unexplained.findings).toEqual([]);
    expect(unexplained.certainty).toMatch(/unknown/);
    expect(unexplained.options.every((o) => o.evidence === "hypothesis")).toBe(true);
  });
});

describe("violatesSafetyFloor (any operations, including model-written candidates)", () => {
  const rn = SCENARIOS.onlyRnOnLeave();
  const capped = SCENARIOS.ruleTooStrict();
  const rest = SCENARIOS.restRuleTooTight();
  const withCovering: ScenarioUiState = {
    ...rn,
    cardsByKind: {
      ...rn.cardsByKind,
      coverings: [{ uid: "preceptor" } as ScenarioUiState["cardsByKind"]["coverings"][number]],
    },
  };
  const cap = (patch: Record<string, unknown>) => ({
    type: "edit_count_rule",
    ruleId: "max-nights",
    description: "At most 1 nights",
    people: ["Nurses"],
    shiftTypes: ["N"],
    dates: ["ALL"],
    expression: "x <= T",
    target: 1,
    weight: "infinity",
    ...patch,
  });
  const BROKEN: [string, ScenarioUiState, unknown[], RegExp][] = [
    [
      "rest rule off",
      rest,
      [
        {
          type: "set_rule_enabled",
          ruleKind: "successions",
          ruleId: "no-day-after-night",
          enabled: false,
        },
      ],
      /rest rule/,
    ],
    [
      "rest rule removed",
      rest,
      [{ type: "remove_rule", ruleKind: "successions", ruleId: "no-double-night" }],
      /rest rule/,
    ],
    [
      "rest rule softened",
      rest,
      [
        {
          type: "edit_succession_rule",
          ruleId: "no-double-night",
          description: "No two nights in a row",
          people: ["Nurses"],
          pattern: ["N", "N"],
          dates: ["ALL"],
          weight: "-10",
        },
      ],
      /rest rule/,
    ],
    [
      "supervision removed",
      withCovering,
      [{ type: "remove_rule", ruleKind: "coverings", ruleId: "preceptor" }],
      /supervision/,
    ],
    [
      "RN rule lowered",
      {
        ...rn,
        cardsByKind: {
          ...rn.cardsByKind,
          requirements: rn.cardsByKind.requirements.map((r) =>
            r.uid === "night-rn" ? { ...r, requiredNumPeople: 2 } : r,
          ),
        },
      },
      [{ type: "set_staffing_requirement_people", ruleId: "night-rn", requiredNumPeople: 1 }],
      /skill-mix/,
    ],
    [
      "RN rule opened to everyone",
      rn,
      [
        {
          type: "edit_staffing_requirement",
          ruleId: "night-rn",
          description: "1 RN every night",
          shiftType: "N",
          qualifiedPeople: ["ALL"],
          dates: ["ALL"],
          requiredNumPeople: 1,
        },
      ],
      /skill-mix/,
    ],
    [
      "RN rule removed",
      rn,
      [{ type: "remove_rule", ruleKind: "requirements", ruleId: "night-rn" }],
      /requirement to 0/,
    ],
    [
      "staffing to 0",
      rn,
      [{ type: "set_staffing_requirement_people", ruleId: "day", requiredNumPeople: 0 }],
      /requirement to 0/,
    ],
    [
      "limit removed",
      capped,
      [{ type: "remove_rule", ruleKind: "counts", ruleId: "max-nights" }],
      /limit/,
    ],
    ["limit made soft", capped, [cap({ weight: "10" })], /limit/],
    ["limit +3", capped, [cap({ target: 4 })], /limit/],
    ["limit dropped for a nurse", capped, [cap({ people: ["ana", "ben", "cara"] })], /limit/],
    [
      "leave cleared with nobody asked",
      rn,
      [{ type: "clear_requests", personId: "rn1", startDate: "2026-11-03", endDate: "2026-11-03" }],
      /leave/,
    ],
    ["invented nurse", rn, [{ type: "add_person", name: "Sarah Lee", groups: [] }], /name/],
    [
      "skilled hire with no host question",
      rn,
      [{ type: "add_person", name: "Borrowed nurse 1", groups: ["RN"] }],
      /qualification/,
    ],
  ];

  it.each(BROKEN)("names the floor a candidate breaks: %s", (_label, state, ops, line) => {
    expect(violatesSafetyFloor(state, ops as Op[], { leaveAsked: false })).toMatch(line);
  });

  it("lets through ordinary edits, the host-asked leave path and a bounded skilled loan", () => {
    const ok = (state: ScenarioUiState, ops: unknown[], leaveAsked = false) =>
      violatesSafetyFloor(state, ops as Op[], { leaveAsked });
    expect(ok(capped, [cap({ target: 3 })])).toBeNull();
    expect(
      ok(rn, [{ type: "set_staffing_requirement_people", ruleId: "day", requiredNumPeople: 2 }]),
    ).toBeNull();
    expect(
      ok(
        rn,
        [
          {
            type: "clear_requests",
            personId: "rn1",
            startDate: "2026-11-03",
            endDate: "2026-11-03",
          },
        ],
        true,
      ),
    ).toBeNull();
    expect(
      ok(rn, [
        { type: "add_person", name: "Borrowed nurse 1", groups: ["RN"] },
        {
          type: "set_off_request",
          personId: "Borrowed nurse 1",
          startDate: "2026-11-01",
          endDate: "2026-11-02",
          weight: "must",
        },
      ]),
    ).toBeNull();
  });
});
