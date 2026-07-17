import { describe, expect, it } from "vitest";
import { createEmptyScenarioUiState, type CountCard, type ScenarioUiState } from "@/lib/scenario";
import {
  buildCountCard,
  buildCountShiftTypeDomain,
  buildCountShiftTypeTransferOptions,
  COUNT_MESSAGES,
  coefficientIdsFor,
  countToForm,
  describeCountExpressionTarget,
  emptyCountForm,
  isAdvancedCountCard,
  isContractedHoursCard,
  isEditableCountCard,
  isInSelection,
  reorderByDrop,
  summarizeRefs,
  toggleInSelection,
  validateCountForm,
  withCardDisabled,
  type CountFormState,
} from "./counts-model";

function scenario(overrides: Partial<ScenarioUiState> = {}): ScenarioUiState {
  return { ...createEmptyScenarioUiState(), ...overrides };
}

function form(overrides: Partial<CountFormState> = {}): CountFormState {
  return { ...emptyCountForm(), ...overrides };
}

const BASE = scenario({
  staff: [{ id: "Anna" }, { id: "Lil" }],
  shifts: [{ id: "D" }, { id: "N" }],
  shiftGroups: [{ id: "Seniors", members: ["D", "N"] }],
});

describe("emptyCountForm defaults (spec 05 FR-PR-50)", () => {
  it("matches the documented generic-count defaults", () => {
    expect(emptyCountForm()).toEqual({
      description: "",
      person: [],
      countDates: [],
      countShiftTypes: [],
      countShiftTypeCoefficients: [],
      expression: "x >= T",
      target: 0,
      weight: -1,
    });
  });
});

describe("selection helpers", () => {
  it("toggle adds then removes by exact identity, order-preserving", () => {
    expect(toggleInSelection([], "D")).toEqual(["D"]);
    expect(toggleInSelection(["D", "N"], "D")).toEqual(["N"]);
    expect(isInSelection(["D"], "D")).toBe(true);
  });

  it('exact identity keeps numeric 1 and string "1" distinct', () => {
    expect(isInSelection<number | string>([1], "1")).toBe(false);
    expect(isInSelection<number | string>([1], 1)).toBe(true);
    expect(toggleInSelection<number | string>([1], "1")).toEqual([1, "1"]);
  });
});

describe("buildCountShiftTypeTransferOptions (FR-PR-51/78 — OFF/LEAVE/ALL included)", () => {
  it("includes OFF/LEAVE as enabled items and ALL as an enabled group", () => {
    const options = buildCountShiftTypeTransferOptions(BASE);
    const off = options.items.find((o) => o.value === "OFF");
    const leave = options.items.find((o) => o.value === "LEAVE");
    const all = options.groups.find((o) => o.value === "ALL");
    expect(off?.disabled).toBeUndefined();
    expect(leave?.disabled).toBeUndefined();
    expect(all?.disabled).toBeUndefined();
  });

  it("disables a numeric shift-type entity id with an actionable reason", () => {
    const state = scenario({ shifts: [{ id: 7 }, { id: "D" }] });
    const options = buildCountShiftTypeTransferOptions(state);
    const numeric = options.items.find((o) => o.value === 7);
    const stringShift = options.items.find((o) => o.value === "D");
    expect(numeric?.disabled).toBe(true);
    expect(numeric?.disabledReason).toBe(COUNT_MESSAGES.numericShiftId);
    expect(stringShift?.disabled).toBeUndefined();
  });
});

describe("buildCountShiftTypeDomain coefficient eligibility (FR-PR-70/78)", () => {
  it("OFF, LEAVE, and ALL are each structurally coefficient-eligible once selected", () => {
    const domain = buildCountShiftTypeDomain(BASE);
    expect(coefficientIdsFor(["OFF"], domain)).toEqual(["OFF"]);
    expect(coefficientIdsFor(["LEAVE"], domain)).toEqual(["LEAVE"]);
    expect(coefficientIdsFor(["ALL"], domain)).toEqual([
      "D",
      "N",
      "OFF",
      "LEAVE",
      "Seniors",
      "ALL",
    ]);
  });

  it("a selected group makes both its member items AND the group itself eligible", () => {
    const domain = buildCountShiftTypeDomain(BASE);
    expect(coefficientIdsFor(["Seniors"], domain)).toEqual(["D", "N", "Seniors"]);
  });

  it("excludes numeric shift ids from the coefficient domain entirely", () => {
    const domain = buildCountShiftTypeDomain(scenario({ shifts: [{ id: 7 }, { id: "D" }] }));
    expect(domain.items.map((i) => i.id)).not.toContain("7");
    expect(domain.items.map((i) => i.id)).toContain("D");
  });
});

describe("validateCountForm (spec 05 Shift Counts validation table)", () => {
  const domain = buildCountShiftTypeDomain(BASE);

  it("sets the verbatim empty-selection messages", () => {
    const errors = validateCountForm(form(), domain);
    expect(errors.person).toBe(COUNT_MESSAGES.person);
    expect(errors.countDates).toBe(COUNT_MESSAGES.countDates);
    expect(errors.countShiftTypes).toBe(COUNT_MESSAGES.countShiftTypes);
  });

  it("rejects a non-integer or negative target", () => {
    const base = form({ person: ["Anna"], countDates: ["2026-01-01"], countShiftTypes: ["D"] });
    expect(validateCountForm({ ...base, target: -1 }, domain).target).toBe(COUNT_MESSAGES.target);
    expect(validateCountForm({ ...base, target: "abc" }, domain).target).toBe(
      COUNT_MESSAGES.target,
    );
    expect(validateCountForm({ ...base, target: 5 }, domain).target).toBeUndefined();
  });

  it("rejects an invalid weight with the verbatim message", () => {
    const base = form({
      person: ["Anna"],
      countDates: ["2026-01-01"],
      countShiftTypes: ["D"],
      target: 5,
    });
    expect(validateCountForm({ ...base, weight: "abc" }, domain).weight).toBe(
      COUNT_MESSAGES.weightInvalid,
    );
  });

  it("squared expression requires a non-positive weight (AC-PR-12)", () => {
    const base = form({
      person: ["Anna"],
      countDates: ["2026-01-01"],
      countShiftTypes: ["D"],
      target: 5,
      expression: "|x - T|^2",
    });
    expect(validateCountForm({ ...base, weight: 1 }, domain).weight).toBe(
      COUNT_MESSAGES.weightSquaredPositive,
    );
    expect(validateCountForm({ ...base, weight: Infinity }, domain).weight).toBe(
      COUNT_MESSAGES.weightSquaredPositive,
    );
    expect(validateCountForm({ ...base, weight: -1 }, domain).weight).toBeUndefined();
    expect(validateCountForm({ ...base, weight: -Infinity }, domain).weight).toBeUndefined();
  });

  it("comparison expressions have no sign restriction (may be ±∞)", () => {
    const base = form({
      person: ["Anna"],
      countDates: ["2026-01-01"],
      countShiftTypes: ["D"],
      target: 5,
      expression: "x >= T",
    });
    expect(validateCountForm({ ...base, weight: Infinity }, domain).weight).toBeUndefined();
    expect(validateCountForm({ ...base, weight: -Infinity }, domain).weight).toBeUndefined();
  });

  it("surfaces coefficient errors in a SEPARATE field from countShiftTypes", () => {
    const base = form({
      person: ["Anna"],
      countDates: ["2026-01-01"],
      countShiftTypes: ["D"],
      countShiftTypeCoefficients: [["D", "bad"]],
      target: 5,
    });
    const errors = validateCountForm(base, domain);
    expect(errors.countShiftTypes).toBeUndefined();
    expect(errors.coefficients).toContain("Coefficient for D must be an integer of at least 1");
    expect(errors.coefficientErrorsById?.D).toBeDefined();
  });

  it("surfaces the overlap error once every coefficient value is individually valid", () => {
    const base = form({
      person: ["Anna"],
      countDates: ["2026-01-01"],
      countShiftTypes: ["Seniors"],
      countShiftTypeCoefficients: [
        ["D", 2],
        ["N", 3],
        ["Seniors", 4],
      ],
      target: 5,
    });
    const errors = validateCountForm(base, domain);
    expect(errors.coefficients).toBe("Shift type coefficients overlap: D, Seniors include D");
  });
});

describe("buildCountCard (spec 05 FR-PR-50..55, FR-PR-54 canonical ordering)", () => {
  const domain = buildCountShiftTypeDomain(BASE);

  it("builds an ordinary card with no tag/policy marker", () => {
    const card = buildCountCard(
      form({ person: ["Anna"], countDates: ["2026-01-01"], countShiftTypes: ["D"], target: 5 }),
      domain,
      "uid-1",
    );
    expect(card.uid).toBe("uid-1");
    expect(card.tag).toBeUndefined();
    expect(card.expression).toBe("x >= T");
    expect(card.target).toBe(5);
    expect(card.weight).toBe(-1);
  });

  it("re-sorts countShiftTypes to canonical entry order on save", () => {
    const card = buildCountCard(
      form({
        person: ["Anna"],
        countDates: ["2026-01-01"],
        countShiftTypes: ["N", "D"],
        target: 5,
      }),
      domain,
      "uid-2",
    );
    expect(card.countShiftTypes).toEqual(["D", "N"]);
  });

  it("attaches coefficients only when at least one value remains (FR-PR-74)", () => {
    const noCoef = buildCountCard(
      form({ person: ["Anna"], countDates: ["2026-01-01"], countShiftTypes: ["D"], target: 5 }),
      domain,
      "uid-3",
    );
    expect(noCoef.countShiftTypeCoefficients).toBeUndefined();

    const withCoef = buildCountCard(
      form({
        person: ["Anna"],
        countDates: ["2026-01-01"],
        countShiftTypes: ["D"],
        countShiftTypeCoefficients: [["D", 3]],
        target: 5,
      }),
      domain,
      "uid-4",
    );
    expect(withCoef.countShiftTypeCoefficients).toEqual([["D", 3]]);
  });

  it("preserves the authored description verbatim (lossless, FR-PR-04)", () => {
    const spaced = buildCountCard(
      form({
        person: ["Anna"],
        countDates: ["2026-01-01"],
        countShiftTypes: ["D"],
        description: "  Night balance  ",
      }),
      domain,
      "u",
    );
    expect(spaced.description).toBe("  Night balance  ");
    const empty = buildCountCard(
      form({ person: ["Anna"], countDates: ["2026-01-01"], countShiftTypes: ["D"] }),
      domain,
      "u2",
    );
    expect(empty.description).toBe("");
  });
});

describe("M1 — typed group-member identity in the coefficient domain", () => {
  // shifts: numeric 1 and string "1" coexist; group G expands to the NUMERIC shift.
  const state = scenario({
    shifts: [{ id: 1 }, { id: "1" }, { id: "D" }],
    shiftGroups: [{ id: "G", members: [1] }],
  });
  const typedDomain = buildCountShiftTypeDomain(state);

  it("keeps numeric shift ids out of the coefficient SOURCE items (string-only sources)", () => {
    expect(typedDomain.items.map((i) => i.id)).toEqual(["1", "D", "OFF", "LEAVE"]);
  });

  it('selecting a group whose member is numeric 1 does NOT make the string shift "1" eligible', () => {
    // Only G itself is a source; the string shift "1" is unrelated to numeric 1.
    expect(coefficientIdsFor(["G"], typedDomain)).toEqual(["G"]);
  });

  it('does not fabricate a false overlap between string shift "1" and group G→[1]', () => {
    // Select both "1" (string item) and G (numeric member); give each a value.
    const errors = validateCountForm(
      form({
        person: ["Anna"],
        countDates: ["2026-01-01"],
        countShiftTypes: ["1", "G"],
        countShiftTypeCoefficients: [
          ["1", 2],
          ["G", 4],
        ],
        target: 5,
      }),
      typedDomain,
    );
    // "1" expands to string "1"; G expands to numeric 1 — disjoint, so no overlap.
    expect(errors.coefficients).toBeUndefined();
  });
});

describe("reorderByDrop (M5, FR-PR-12 pointer half)", () => {
  const list = [{ uid: "A" }, { uid: "B" }, { uid: "C" }, { uid: "D" }];

  it("inserts BEFORE the hovered card (upper half)", () => {
    expect(reorderByDrop(list, "A", "C", "before").map((c) => c.uid)).toEqual(["B", "A", "C", "D"]);
  });

  it("inserts AFTER the hovered card (lower half)", () => {
    expect(reorderByDrop(list, "A", "C", "after").map((c) => c.uid)).toEqual(["B", "C", "A", "D"]);
  });

  it("moves a later card up before an earlier one", () => {
    expect(reorderByDrop(list, "D", "B", "before").map((c) => c.uid)).toEqual(["A", "D", "B", "C"]);
  });

  it("is a no-op when from === to or a uid is missing", () => {
    expect(reorderByDrop(list, "A", "A", "before").map((c) => c.uid)).toEqual(["A", "B", "C", "D"]);
    expect(reorderByDrop(list, "Z", "B", "after").map((c) => c.uid)).toEqual(["A", "B", "C", "D"]);
  });
});

describe("countToForm load round-trip", () => {
  const domain = buildCountShiftTypeDomain(BASE);

  it("normalizes scalar person/dates/shiftTypes fields to arrays", () => {
    const card: CountCard = {
      uid: "u1",
      person: "Anna",
      countDates: "2026-01-01",
      countShiftTypes: "D",
      expression: "x >= T",
      target: 5,
      weight: -1,
    };
    const loaded = countToForm(card, domain);
    expect(loaded.person).toEqual(["Anna"]);
    expect(loaded.countDates).toEqual(["2026-01-01"]);
    expect(loaded.countShiftTypes).toEqual(["D"]);
  });

  it("re-syncs coefficients against the current domain, dropping a stale id", () => {
    const card: CountCard = {
      uid: "u2",
      person: ["Anna"],
      countDates: ["2026-01-01"],
      countShiftTypes: ["D"],
      countShiftTypeCoefficients: [
        ["D", 2],
        ["Ghost", 9],
      ],
      expression: "x >= T",
      target: 5,
      weight: -1,
    };
    const loaded = countToForm(card, domain);
    expect(loaded.countShiftTypeCoefficients).toEqual([["D", 2]]);
  });

  it("falls back to a scalar expression/target when loading an array (defensive; callers must guard)", () => {
    const card: CountCard = {
      uid: "u3",
      person: ["Anna"],
      countDates: ["2026-01-01"],
      countShiftTypes: ["D"],
      expression: ["x >= T", "x <= T"],
      target: [10, 20],
      weight: Infinity,
    };
    const loaded = countToForm(card, domain);
    expect(loaded.expression).toBe("x >= T");
    expect(loaded.target).toBe(0);
  });
});

describe("generic-array lossless fallback (FR-PR-55a)", () => {
  it("recognizes an unmarked array expression/target as advanced and not editable", () => {
    const card: CountCard = {
      uid: "adv",
      person: ["Anna"],
      countDates: ["2026-01-01"],
      countShiftTypes: ["D"],
      expression: ["x >= T", "x <= T"],
      target: [10, 20],
      weight: Infinity,
    };
    expect(isAdvancedCountCard(card)).toBe(true);
    expect(isContractedHoursCard(card)).toBe(false);
    expect(isEditableCountCard(card)).toBe(false);
  });

  it("a scalar unmarked card is editable and not advanced", () => {
    const card: CountCard = {
      uid: "ord",
      person: ["Anna"],
      countDates: ["2026-01-01"],
      countShiftTypes: ["D"],
      expression: "x >= T",
      target: 5,
      weight: -1,
    };
    expect(isAdvancedCountCard(card)).toBe(false);
    expect(isEditableCountCard(card)).toBe(true);
  });

  it("a contracted-hours (tag) card is recognized but not editable here (M2 seam)", () => {
    const card: CountCard = {
      uid: "ch",
      tag: "contracted_hours",
      policy: "exact",
      person: ["Anna"],
      countDates: ["2026-01-01"],
      countShiftTypes: ["D"],
      expression: "x = T",
      target: 320,
      weight: Infinity,
    };
    expect(isContractedHoursCard(card)).toBe(true);
    expect(isAdvancedCountCard(card)).toBe(false);
    expect(isEditableCountCard(card)).toBe(false);
  });
});

describe("describeCountExpressionTarget (card summary)", () => {
  it("substitutes T for a scalar pair", () => {
    expect(describeCountExpressionTarget("x >= T", 5)).toBe("x >= 5");
  });

  it("substitutes T per indexed pair for an array (range) pair", () => {
    expect(describeCountExpressionTarget(["x >= T", "x <= T"], [300, 340])).toBe(
      "x >= 300, x <= 340",
    );
  });

  it("falls back to raw sides on a shape mismatch", () => {
    expect(describeCountExpressionTarget(["x >= T", "x <= T"], [300])).toBe(
      "x >= T, x <= T (target 300)",
    );
  });
});

describe("summarizeRefs", () => {
  it("comma-joins a scalar or array ref", () => {
    expect(summarizeRefs("Anna")).toBe("Anna");
    expect(summarizeRefs(["Anna", "Lil"])).toBe("Anna, Lil");
  });
});

describe("withCardDisabled (M4)", () => {
  it("sets and strips the disabled marker without touching other fields", () => {
    const card: CountCard = {
      uid: "u",
      person: ["Anna"],
      countDates: ["2026-01-01"],
      countShiftTypes: ["D"],
      expression: "x >= T",
      target: 5,
      weight: -1,
    };
    const off = withCardDisabled(card, true);
    expect(off.disabled).toBe(true);
    const on = withCardDisabled(off, false);
    expect("disabled" in on).toBe(false);
    expect(on.target).toBe(5);
  });
});
