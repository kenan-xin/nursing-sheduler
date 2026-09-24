import { describe, expect, it } from "vitest";
import {
  createEmptyScenarioUiState,
  type RequirementCard,
  type ScenarioUiState,
} from "@/lib/scenario";
import { RenameCollisionError } from "@/lib/cascade";
import {
  OVERRIDE_MESSAGES,
  REQUIREMENT_MESSAGES,
} from "@/components/requirements/requirements-model";
import {
  NumericShiftTypeStaffingError,
  ReservedShiftTypeError,
  ShiftRequirementValidationError,
  StaleShiftRequirementError,
  resolveStaffingCardState,
  saveShiftTypeCard,
  type SaveShiftTypeCardInput,
  type SaveShiftTypeCardResult,
} from "./save-shift-card";

function scenario(overrides: Partial<ScenarioUiState> = {}): ScenarioUiState {
  const empty = createEmptyScenarioUiState();
  return {
    ...empty,
    rangeStart: "2026-07-01",
    rangeEnd: "2026-07-07",
    shifts: [{ id: "Day" }, { id: "Night" }],
    ...overrides,
    cardsByKind: {
      ...empty.cardsByKind,
      ...overrides.cardsByKind,
    },
  };
}

function baseline(overrides: Partial<RequirementCard> = {}): RequirementCard {
  return {
    uid: "req-day",
    description: "Day baseline",
    shiftType: ["Day"],
    shiftTypeCoefficients: [["Day", 2]],
    requiredNumPeople: 2,
    preferredNumPeople: 3,
    qualifiedPeople: ["ALL"],
    date: ["ALL"],
    weight: -25,
    applied: true,
    ...overrides,
  };
}

function editInput(
  opened: ScenarioUiState,
  overrides: Partial<SaveShiftTypeCardInput & { mode: "edit" }> = {},
): SaveShiftTypeCardInput {
  const staffing = resolveStaffingCardState(opened, "Day");
  if (staffing.kind !== "editable") throw new Error("test requires editable staffing");
  return {
    mode: "edit",
    shiftTypeId: "Day",
    fields: { code: "Day", name: "Day shift", workingTime: {} },
    staffing: {
      type: "editable",
      token: staffing.token,
      required: 4,
      preferred: 5,
    },
    ...overrides,
  };
}

/**
 * Drive the save against an in-memory document. T03: the commit seam is async (a
 * queued repository command), so the outcome and any refusal are only observable
 * after awaiting — the updater itself still runs synchronously inside it.
 */
async function apply(
  live: ScenarioUiState,
  input: SaveShiftTypeCardInput,
): Promise<{
  next: ScenarioUiState;
  calls: number;
  result: SaveShiftTypeCardResult;
}> {
  let next = live;
  let calls = 0;
  const result = await saveShiftTypeCard(async (updater) => {
    calls += 1;
    const patch = updater(next);
    next = { ...next, ...patch };
    return { ok: true };
  }, input);
  return { next, calls, result };
}

describe("saveShiftTypeCard", () => {
  it("updates a simple baseline without clobbering description, coefficients, markers, or weight", async () => {
    const card = baseline();
    const opened = scenario({
      cardsByKind: {
        ...createEmptyScenarioUiState().cardsByKind,
        requirements: [card],
      },
    });

    const { next, calls } = await apply(opened, editInput(opened));

    expect(calls).toBe(1);
    expect(next.cardsByKind.requirements[0]).toEqual({
      ...card,
      requiredNumPeople: 4,
      preferredNumPeople: 5,
    });
  });

  it("creates a validated all-nurses/all-dates baseline with post-shift string selector", async () => {
    const opened = scenario({ shifts: [{ id: "Day" }] });
    const input = editInput(opened);
    const { next, result } = await apply(opened, input);

    expect(result.requirement).toBe("created");
    expect(next.cardsByKind.requirements).toHaveLength(1);
    expect(next.cardsByKind.requirements[0]).toMatchObject({
      shiftType: ["Day"],
      qualifiedPeople: ["ALL"],
      date: ["ALL"],
      requiredNumPeople: 4,
      preferredNumPeople: 5,
      weight: -50,
    });
  });

  it("treats a disabled baseline as no active coverage and creates without editing it", async () => {
    const disabled = baseline({ disabled: true });
    const opened = scenario({
      cardsByKind: {
        ...createEmptyScenarioUiState().cardsByKind,
        requirements: [disabled],
      },
    });

    const { next } = await apply(opened, editInput(opened));

    expect(next.cardsByKind.requirements).toHaveLength(2);
    expect(next.cardsByKind.requirements[0]).toBe(disabled);
    expect(next.cardsByKind.requirements[1]).toMatchObject({
      shiftType: ["Day"],
      requiredNumPeople: 4,
    });
  });

  it("edits the first duplicate all-scope baseline in array order", async () => {
    const first = baseline({ uid: "first" });
    const second = baseline({ uid: "second", requiredNumPeople: 8, preferredNumPeople: 9 });
    const opened = scenario({
      cardsByKind: {
        ...createEmptyScenarioUiState().cardsByKind,
        requirements: [first, second],
      },
    });

    const { next } = await apply(opened, editInput(opened));

    expect(next.cardsByKind.requirements[0].requiredNumPeople).toBe(4);
    expect(next.cardsByKind.requirements[1]).toBe(second);
  });

  it("renames first, keeps the cascade, and patches the post-rename requirement ref", async () => {
    const card = baseline();
    const opened = scenario({
      shiftGroups: [{ id: "WORKING", members: ["Day"] }],
      cardsByKind: {
        ...createEmptyScenarioUiState().cardsByKind,
        requirements: [card],
      },
    });
    const input = editInput(opened);
    if (input.mode !== "edit") throw new Error("unreachable");
    input.fields.code = "AM";

    const { next } = await apply(opened, input);

    expect(next.shifts.map((shift) => shift.id)).toEqual(["AM", "Night"]);
    expect(next.shiftGroups[0].members).toEqual(["AM"]);
    expect(next.cardsByKind.requirements[0].shiftType).toEqual(["AM"]);
    expect(next.cardsByKind.requirements[0].requiredNumPeople).toBe(4);
  });

  it("aborts changed and deleted baseline identities without committing a write", async () => {
    const card = baseline();
    const opened = scenario({
      cardsByKind: {
        ...createEmptyScenarioUiState().cardsByKind,
        requirements: [card],
      },
    });
    const input = editInput(opened);
    const changed = scenario({
      cardsByKind: {
        ...opened.cardsByKind,
        requirements: [{ ...card, requiredNumPeople: 7 }],
      },
    });
    const deleted = scenario({
      cardsByKind: { ...opened.cardsByKind, requirements: [] },
    });

    for (const live of [changed, deleted]) {
      let committed = false;
      await expect(
        saveShiftTypeCard(async (updater) => {
          updater(live);
          committed = true;
          return { ok: true };
        }, input),
      ).rejects.toThrow(StaleShiftRequirementError);
      expect(committed).toBe(false);
    }
  });

  it("rejects validation and rename collisions with zero committed writes", async () => {
    const card = baseline();
    const opened = scenario({
      cardsByKind: {
        ...createEmptyScenarioUiState().cardsByKind,
        requirements: [card],
      },
    });
    const invalid = editInput(opened);
    if (invalid.staffing.type !== "editable") throw new Error("unreachable");
    invalid.staffing.required = -1;

    let committed = false;
    await expect(
      saveShiftTypeCard(async (updater) => {
        updater(opened);
        committed = true;
        return { ok: true };
      }, invalid),
    ).rejects.toThrow(ShiftRequirementValidationError);
    expect(committed).toBe(false);

    const collision = editInput(opened);
    collision.fields.code = "Night";
    await expect(
      saveShiftTypeCard(async (updater) => {
        updater(opened);
        committed = true;
        return { ok: true };
      }, collision),
    ).rejects.toThrow(RenameCollisionError);
    expect(committed).toBe(false);
  });

  it("surfaces the override error instead of the generic fallback message", async () => {
    // A 2-to-4 rule with an exception on 3 Jul pinned to the ceiling (4). Lowering
    // Preferred to 3 on the Shift types screen now puts that exception above the
    // new ceiling, and the refusal must say so (S1) instead of falling through to
    // "Fix the staffing requirement errors first."
    const card = baseline({
      requiredNumPeople: 2,
      preferredNumPeople: 4,
      date: ["ALL"],
      requiredNumPeopleOverrides: [["2026-07-03", 4]],
    });
    const opened = scenario({
      cardsByKind: { ...createEmptyScenarioUiState().cardsByKind, requirements: [card] },
    });
    const input = editInput(opened);
    if (input.staffing.type !== "editable") throw new Error("editable");
    input.staffing.required = 2;
    input.staffing.preferred = 3;

    await expect(apply(opened, input)).rejects.toThrow(OVERRIDE_MESSAGES.abovePreferred("3 Jul"));
  });

  it("rejects reserved and numeric selector writes before invoking the mutation", async () => {
    const mutate = () => {
      throw new Error("must not run");
    };
    await expect(
      saveShiftTypeCard(mutate, {
        mode: "edit",
        shiftTypeId: "OFF",
        fields: { code: "OFF", name: "", workingTime: {} },
        staffing: { type: "none" },
      }),
    ).rejects.toThrow(ReservedShiftTypeError);
    await expect(
      saveShiftTypeCard(mutate, {
        mode: "edit",
        shiftTypeId: 1,
        fields: { code: "1", name: "", workingTime: {} },
        staffing: {
          type: "editable",
          token: { baselineUid: null, baselineCard: null },
          required: 2,
          preferred: "",
        },
      }),
    ).rejects.toThrow(NumericShiftTypeStaffingError);
    // Add-mode defense in depth: a numbers-only code can't build a valid selector.
    await expect(
      saveShiftTypeCard(mutate, {
        mode: "add",
        fields: { code: "1", name: "", workingTime: {} },
        staffing: {
          type: "editable",
          token: { baselineUid: null, baselineCard: null },
          required: 2,
          preferred: "",
        },
      }),
    ).rejects.toThrow(NumericShiftTypeStaffingError);
  });

  it("makes EDGE-PR-03 explicit in the result and writes the forced collapse", async () => {
    const card = baseline();
    const opened = scenario({
      cardsByKind: {
        ...createEmptyScenarioUiState().cardsByKind,
        requirements: [card],
      },
    });
    const input = editInput(opened);
    if (input.staffing.type !== "editable") throw new Error("unreachable");
    input.staffing.required = 2;
    input.staffing.preferred = 2;

    const { next, result } = await apply(opened, input);

    expect(result.preferredCollapsed).toBe(true);
    expect(next.cardsByKind.requirements[0].preferredNumPeople).toBeUndefined();
    expect(next.cardsByKind.requirements[0].weight).toBe(-1);
  });
});

describe("skill mix on the Shifts page", () => {
  const mixCard = baseline({
    shiftTypeCoefficients: undefined,
    preferredNumPeople: undefined,
    requiredNumPeople: 3,
    skillMix: [{ people: "RN", minNumPeople: 2 }],
  });
  const opened = scenario({
    staffGroups: [{ id: "RN", members: [] }],
    cardsByKind: { ...createEmptyScenarioUiState().cardsByKind, requirements: [mixCard] },
  });
  const withStaffing = (required: number) => {
    const input = editInput(opened);
    if (input.staffing.type !== "editable") throw new Error("editable");
    return { ...input, staffing: { ...input.staffing, required, preferred: "" } };
  };

  it("refuses staffing below the skill mix", async () => {
    await expect(apply(opened, withStaffing(1))).rejects.toThrow(
      REQUIREMENT_MESSAGES.skillMixAboveRequired,
    );
  });

  it("keeps the skill mix when staffing changes", async () => {
    const { next } = await apply(opened, withStaffing(3));
    expect(next.cardsByKind.requirements[0].skillMix).toEqual([{ people: "RN", minNumPeople: 2 }]);
  });

  it("shows the skill mix as a staffing chip", () => {
    const resolved = resolveStaffingCardState(opened, "Day");
    expect(resolved.kind === "editable" && resolved.contextChips).toContain("at least 2 RN");
  });
});

describe("resolveStaffingCardState", () => {
  it("keeps qualified/date/group/multi-only coverage read-only and names the actual rule", () => {
    const cases: Array<[RequirementCard, Partial<ScenarioUiState>, string]> = [
      [baseline({ qualifiedPeople: ["Seniors"] }), {}, "Seniors: 2 nurses"],
      [baseline({ date: ["2026-07-01"] }), {}, "2026-07-01: 2 nurses"],
      [
        baseline({ shiftType: ["WORKING"] }),
        { shiftGroups: [{ id: "WORKING", members: ["Day"] }] },
        "WORKING group",
      ],
      [baseline({ shiftType: ["Day", "Night"] }), {}, "staffs Day + Night together"],
    ];

    for (const [card, overrides, expected] of cases) {
      const state = scenario({
        ...overrides,
        cardsByKind: {
          ...createEmptyScenarioUiState().cardsByKind,
          requirements: [card],
        },
      });
      const resolved = resolveStaffingCardState(state, "Day");
      expect(resolved.kind).toBe("readonly");
      if (resolved.kind === "readonly") expect(resolved.ruleSummary).toContain(expected);
    }
  });
});
