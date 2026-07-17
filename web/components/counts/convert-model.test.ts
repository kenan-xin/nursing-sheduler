import { describe, expect, it } from "vitest";
import {
  createEmptyScenarioUiState,
  type ContractedHoursCountCard,
  type OrdinaryCountCard,
  type ScenarioUiState,
} from "@/lib/scenario";
import { isAdvancedCountCard, isContractedHoursCard, isEditableCountCard } from "./counts-model";
import { convertContractedToGeneric, seedContractedFormFromGeneric } from "./convert-model";

function scenario(overrides: Partial<ScenarioUiState> = {}): ScenarioUiState {
  return { ...createEmptyScenarioUiState(), ...overrides };
}

const BASE = scenario({
  staff: [{ id: "Anna" }],
  shifts: [{ id: "D" }, { id: "N" }],
  shiftGroups: [{ id: "Both", members: ["D", "N"] }],
});

const exactCard: ContractedHoursCountCard = {
  uid: "uid-exact",
  description: "Monthly contract",
  tag: "contracted_hours",
  policy: "exact",
  unit: "half-hour",
  disabled: true,
  person: ["Anna"],
  countDates: ["ALL"],
  countShiftTypes: ["D"],
  countShiftTypeCoefficients: [["D", 16]],
  expression: "x = T",
  target: 320,
  weight: Infinity,
};

const rangeCard: ContractedHoursCountCard = {
  uid: "uid-range",
  tag: "contracted_hours",
  policy: "range",
  unit: "half-hour",
  person: ["Anna"],
  countDates: ["ALL"],
  countShiftTypes: ["D"],
  expression: ["x >= T", "x <= T"],
  target: [300, 340],
  weight: Infinity,
};

describe("convertContractedToGeneric", () => {
  it("strips the marker from an Exact card, yielding an editable ordinary count", () => {
    const result = convertContractedToGeneric(exactCard);
    expect(result.tag).toBeUndefined();
    expect(result.policy).toBeUndefined();
    expect(result.unit).toBeUndefined();
    expect(isContractedHoursCard(result)).toBe(false);
    expect(isEditableCountCard(result)).toBe(true);
    expect(isAdvancedCountCard(result)).toBe(false);
  });

  it("preserves uid, disabled, and every raw field on an Exact card", () => {
    const result = convertContractedToGeneric(exactCard);
    expect(result.uid).toBe("uid-exact");
    expect(result.disabled).toBe(true);
    expect(result.description).toBe("Monthly contract");
    expect(result.person).toEqual(["Anna"]);
    expect(result.countDates).toEqual(["ALL"]);
    expect(result.countShiftTypes).toEqual(["D"]);
    expect(result.countShiftTypeCoefficients).toEqual([["D", 16]]);
    expect(result.expression).toBe("x = T");
    expect(result.target).toBe(320);
    expect(result.weight).toBe(Infinity);
  });

  it("yields an unmarked ADVANCED (list) card from a Range card", () => {
    const result = convertContractedToGeneric(rangeCard);
    expect(isContractedHoursCard(result)).toBe(false);
    expect(isEditableCountCard(result)).toBe(false);
    expect(isAdvancedCountCard(result)).toBe(true);
    // The raw array fields survive untouched.
    expect(result.expression).toEqual(["x >= T", "x <= T"]);
    expect(result.target).toEqual([300, 340]);
  });

  it("does not mutate the source card", () => {
    const snapshot = structuredClone(exactCard);
    convertContractedToGeneric(exactCard);
    expect(exactCard).toEqual(snapshot);
  });
});

describe("seedContractedFormFromGeneric", () => {
  const generic: OrdinaryCountCard = {
    uid: "uid-gen",
    description: "Working shifts",
    person: ["Anna"],
    countDates: ["ALL"],
    countShiftTypes: ["D"],
    countShiftTypeCoefficients: [["D", 3]],
    expression: "x >= T",
    target: 5,
    weight: -1,
  };

  it("carries fields, defaults policy to exact, and leaves the target BLANK", () => {
    const seeded = seedContractedFormFromGeneric(generic, BASE);
    expect(seeded.description).toBe("Working shifts");
    expect(seeded.person).toEqual(["Anna"]);
    expect(seeded.countDates).toEqual(["ALL"]);
    expect(seeded.countShiftTypes).toEqual(["D"]);
    expect(seeded.policy).toBe("exact");
    expect(seeded.targetExact).toBe("");
    expect(seeded.targetRangeMin).toBe("");
    expect(seeded.targetRangeMax).toBe("");
  });

  it("re-syncs the existing coefficients to the concrete contracted domain", () => {
    const seeded = seedContractedFormFromGeneric(generic, BASE);
    // D is the only selected concrete leaf source — its manual override is preserved.
    expect(seeded.countShiftTypeCoefficients).toEqual([["D", 3]]);
  });

  it("drops a coefficient id no longer eligible under the concrete domain", () => {
    const withStale: OrdinaryCountCard = {
      ...generic,
      countShiftTypes: ["D"],
      countShiftTypeCoefficients: [
        ["D", 3],
        ["N", 4],
      ],
    };
    const seeded = seedContractedFormFromGeneric(withStale, BASE);
    // Only D is selected, so N is not in the concrete domain and is dropped.
    expect(seeded.countShiftTypeCoefficients).toEqual([["D", 3]]);
  });

  it("adds a blank slot for a newly-eligible concrete id (group expansion)", () => {
    const grouped: OrdinaryCountCard = {
      ...generic,
      countShiftTypes: ["Both"],
      countShiftTypeCoefficients: [["D", 3]],
    };
    const seeded = seedContractedFormFromGeneric(grouped, BASE);
    // Both expands to D + N over the concrete leaf domain: D keeps its override, N is blank.
    expect(seeded.countShiftTypeCoefficients).toEqual([
      ["D", 3],
      ["N", ""],
    ]);
  });
});
