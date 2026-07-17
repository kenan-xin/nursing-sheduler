import { describe, expect, it } from "vitest";
import {
  createEmptyScenarioUiState,
  type ContractedHoursCountCard,
  type ScenarioUiState,
} from "@/lib/scenario";
import {
  buildContractedCard,
  buildContractedCoefficientDomain,
  contractedCoefficientIds,
  emptyContractedForm,
  hasContractedErrors,
  toContractedForm,
  validateContractedCommit,
  validateContractedForm,
  type ContractedFormState,
} from "./contracted-model";
import {
  LEAVE_CREDIT_HALF_HOURS,
  formatHalfHourRange,
  formatHalfHours,
  parseHalfHourRange,
  parseHalfHours,
  parseRawHalfHours,
} from "./half-hour-codec";

function scenario(overrides: Partial<ScenarioUiState> = {}): ScenarioUiState {
  return { ...createEmptyScenarioUiState(), ...overrides };
}

function form(overrides: Partial<ContractedFormState> = {}): ContractedFormState {
  return { ...emptyContractedForm(), ...overrides };
}

const BASE = scenario({
  staff: [{ id: "Anna" }, { id: "Lil" }],
  shifts: [{ id: "D" }, { id: "N" }],
});

describe("half-hour codec (scalar)", () => {
  it("formats integer half-hours as human hours", () => {
    expect(formatHalfHours(320)).toBe("160h");
    expect(formatHalfHours(17)).toBe("8h 30m");
    expect(formatHalfHours(300)).toBe("150h");
    expect(formatHalfHours(0)).toBe("0h");
    expect(formatHalfHours(1)).toBe("0h 30m");
  });

  it("parses human hours (and bare numbers) to integer half-hours", () => {
    expect(parseHalfHours("160h")).toBe(320);
    expect(parseHalfHours("160")).toBe(320);
    expect(parseHalfHours("8h 30m")).toBe(17);
    expect(parseHalfHours("8.5h")).toBe(17);
    expect(parseHalfHours("150h")).toBe(300);
    expect(parseHalfHours("30m")).toBe(1);
    expect(parseHalfHours(" 0 ")).toBe(0);
  });

  it("rejects off-grid, negative, and unparseable input as null", () => {
    expect(parseHalfHours("8h 15m")).toBeNull();
    expect(parseHalfHours("8.25h")).toBeNull();
    expect(parseHalfHours("-5")).toBeNull();
    expect(parseHalfHours("")).toBeNull();
    expect(parseHalfHours("abc")).toBeNull();
  });

  it("round-trips losslessly for on-grid values", () => {
    for (const halfHours of [0, 1, 16, 17, 300, 320, 340]) {
      expect(parseHalfHours(formatHalfHours(halfHours))).toBe(halfHours);
    }
  });

  it("rejects magnitudes past the safe-integer boundary (parseFloat has already rounded)", () => {
    // 2^53+1 hours: parseFloat rounds it, so a naive isInteger check would accept a
    // silently-different target. isSafeInteger must reject it.
    expect(parseHalfHours("9007199254740993h")).toBeNull();
    // A whole-hour amount whose doubled half-hour total exceeds 2^53 is also unsafe.
    expect(parseHalfHours("9007199254740992h")).toBeNull();
    expect(parseHalfHours("1e308h")).toBeNull();
    // A realistic large-but-safe target still round-trips (e.g. 10,000h → 20,000).
    expect(parseHalfHours(formatHalfHours(20_000))).toBe(20_000);
  });

  it("exposes the LEAVE default credit as 16 half-hours (8h)", () => {
    expect(LEAVE_CREDIT_HALF_HOURS).toBe(16);
    expect(formatHalfHours(LEAVE_CREDIT_HALF_HOURS)).toBe("8h");
  });

  it("parseRawHalfHours accepts clean non-negative integers and rejects everything else", () => {
    expect(parseRawHalfHours("320")).toBe(320);
    expect(parseRawHalfHours(" 16 ")).toBe(16);
    expect(parseRawHalfHours("0")).toBe(0);
    // Reject (never truncate) decimals, exponents, signs, and unsafe magnitudes.
    expect(parseRawHalfHours("3.5")).toBeNull();
    expect(parseRawHalfHours("1e3")).toBeNull();
    expect(parseRawHalfHours("-5")).toBeNull();
    expect(parseRawHalfHours("")).toBeNull();
    expect(parseRawHalfHours("abc")).toBeNull();
    expect(parseRawHalfHours("9007199254740993")).toBeNull();
  });
});

describe("half-hour codec (range)", () => {
  it("formats and parses a [min, max] range round-trip", () => {
    expect(formatHalfHourRange([300, 340])).toBe("150–170h");
    expect(parseHalfHourRange("150–170h")).toEqual([300, 340]);
    expect(parseHalfHourRange("150-170h")).toEqual([300, 340]);
    expect(parseHalfHourRange("150 to 170h")).toEqual([300, 340]);
  });

  it("rejects a malformed range as null", () => {
    expect(parseHalfHourRange("150h")).toBeNull();
    expect(parseHalfHourRange("150–8h 15m")).toBeNull();
  });
});

describe("emptyContractedForm", () => {
  it("defaults to exact policy, empty selections, blank targets", () => {
    expect(emptyContractedForm()).toEqual({
      description: "",
      person: [],
      countDates: [],
      countShiftTypes: [],
      countShiftTypeCoefficients: [],
      policy: "exact",
      targetExact: "",
      targetRangeMin: "",
      targetRangeMax: "",
    });
  });
});

describe("validateContractedForm", () => {
  it("requires selections and a parseable exact target", () => {
    const errors = validateContractedForm(emptyContractedForm());
    expect(errors.person).toBeDefined();
    expect(errors.countDates).toBeDefined();
    expect(errors.countShiftTypes).toBeDefined();
    expect(errors.targetExact).toBeDefined();
  });

  it("passes a fully-specified exact draft", () => {
    const errors = validateContractedForm(
      form({
        person: ["Anna"],
        countDates: ["ALL"],
        countShiftTypes: ["D"],
        targetExact: "160h",
      }),
    );
    expect(errors).toEqual({});
  });

  it("flags a range whose minimum exceeds its maximum", () => {
    const errors = validateContractedForm(
      form({
        policy: "range",
        person: ["Anna"],
        countDates: ["ALL"],
        countShiftTypes: ["D"],
        targetRangeMin: "170h",
        targetRangeMax: "150h",
      }),
    );
    expect(errors.targetRangeMax).toBeDefined();
  });
});

describe("buildContractedCard — exact policy", () => {
  it("encodes x = T with a scalar target, .inf weight, and the half-hour marker", () => {
    const card = buildContractedCard(
      form({
        description: "Monthly contract",
        person: ["Anna"],
        countDates: ["ALL"],
        countShiftTypes: ["D"],
        targetExact: "160h",
      }),
      BASE,
      "uid-exact",
    );
    expect(card).toMatchObject({
      uid: "uid-exact",
      description: "Monthly contract",
      tag: "contracted_hours",
      policy: "exact",
      unit: "half-hour",
      expression: "x = T",
      target: 320,
      weight: Infinity,
      person: ["Anna"],
      countDates: ["ALL"],
      countShiftTypes: ["D"],
    });
    expect(card.countShiftTypeCoefficients).toBeUndefined();
  });
});

describe("buildContractedCard — range policy", () => {
  it("encodes ['x >= T', 'x <= T'] with a [min, max] target", () => {
    const card = buildContractedCard(
      form({
        policy: "range",
        person: ["Anna"],
        countDates: ["ALL"],
        countShiftTypes: ["D"],
        targetRangeMin: "150h",
        targetRangeMax: "170h",
      }),
      BASE,
      "uid-range",
    );
    expect(card.policy).toBe("range");
    expect(card.expression).toEqual(["x >= T", "x <= T"]);
    expect(card.target).toEqual([300, 340]);
    expect(card.weight).toBe(Infinity);
    expect(card.unit).toBe("half-hour");
  });
});

describe("buildContractedCard — coefficients", () => {
  it("attaches coefficient entries only when non-empty", () => {
    const card = buildContractedCard(
      form({
        person: ["Anna"],
        countDates: ["ALL"],
        countShiftTypes: ["D"],
        countShiftTypeCoefficients: [["D", 2]],
        targetExact: "160h",
      }),
      BASE,
      "uid-coef",
    );
    expect(card.countShiftTypeCoefficients).toEqual([["D", 2]]);
  });
});

describe("toContractedForm — round-trips a marked card into a draft", () => {
  it("loads an exact card's scalar target back to human hours", () => {
    const card: ContractedHoursCountCard = {
      uid: "uid-exact",
      description: "Monthly contract",
      tag: "contracted_hours",
      policy: "exact",
      unit: "half-hour",
      person: ["Anna"],
      countDates: ["ALL"],
      countShiftTypes: ["D"],
      expression: "x = T",
      target: 320,
      weight: Infinity,
    };
    const draft = toContractedForm(card, BASE);
    expect(draft.policy).toBe("exact");
    expect(draft.targetExact).toBe("160h");
    expect(draft.targetRangeMin).toBe("");
    expect(draft.person).toEqual(["Anna"]);
    expect(draft.countShiftTypes).toEqual(["D"]);
  });

  it("loads a range card's [min, max] target back to human hours", () => {
    const card: ContractedHoursCountCard = {
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
    const draft = toContractedForm(card, BASE);
    expect(draft.policy).toBe("range");
    expect(draft.targetRangeMin).toBe("150h");
    expect(draft.targetRangeMax).toBe("170h");
  });

  it("preserves the marker + encoding on a build → load → build round-trip", () => {
    const original = buildContractedCard(
      form({
        description: "Monthly contract",
        person: ["Anna"],
        countDates: ["ALL"],
        countShiftTypes: ["D"],
        targetExact: "160h",
      }),
      BASE,
      "uid-rt",
    );
    const rebuilt = buildContractedCard(toContractedForm(original, BASE), BASE, "uid-rt");
    expect(rebuilt).toEqual(original);
  });
});

const GROUPED = scenario({
  staff: [{ id: "Anna" }],
  shifts: [{ id: "D" }, { id: "N" }],
  shiftGroups: [{ id: "Both", members: ["D", "N"] }],
});

describe("buildContractedCoefficientDomain — concrete leaf bijection", () => {
  it("expands a selected group to its concrete member rows, with no group/ALL row", () => {
    const domain = buildContractedCoefficientDomain(GROUPED, ["Both"]);
    expect(contractedCoefficientIds(domain)).toEqual(["D", "N"]);
    expect(domain.groups).toEqual([]);
  });

  it("expands ALL to worked shift types only (never a group/ALL/OFF row)", () => {
    const domain = buildContractedCoefficientDomain(GROUPED, ["ALL"]);
    expect(contractedCoefficientIds(domain)).toEqual(["D", "N"]);
  });

  it("includes LEAVE when selected", () => {
    const domain = buildContractedCoefficientDomain(GROUPED, ["D", "LEAVE"]);
    expect(contractedCoefficientIds(domain)).toEqual(["D", "LEAVE"]);
  });

  it("excludes OFF even when it is selected", () => {
    const domain = buildContractedCoefficientDomain(GROUPED, ["D", "OFF"]);
    expect(contractedCoefficientIds(domain)).toEqual(["D"]);
  });

  it("is empty when nothing is selected", () => {
    expect(contractedCoefficientIds(buildContractedCoefficientDomain(GROUPED, []))).toEqual([]);
  });
});

describe("validateContractedCommit — coverage-gated commit via the shared validator", () => {
  const complete = (overrides: Partial<ContractedFormState> = {}) =>
    form({
      person: ["Anna"],
      countDates: ["ALL"],
      countShiftTypes: ["D"],
      countShiftTypeCoefficients: [["D", 16]],
      targetExact: "160h",
      ...overrides,
    });

  it("returns no errors for a fully-covered Exact contract", () => {
    const errors = validateContractedCommit(complete(), GROUPED);
    expect(hasContractedErrors(errors)).toBe(false);
  });

  it("returns no errors for a fully-covered Range contract", () => {
    const errors = validateContractedCommit(
      complete({
        policy: "range",
        targetExact: "",
        targetRangeMin: "150h",
        targetRangeMax: "170h",
      }),
      GROUPED,
    );
    expect(hasContractedErrors(errors)).toBe(false);
  });

  it("returns no errors when a group selector's members are all covered", () => {
    const errors = validateContractedCommit(
      complete({
        countShiftTypes: ["Both"],
        countShiftTypeCoefficients: [
          ["D", 16],
          ["N", 16],
        ],
      }),
      GROUPED,
    );
    expect(hasContractedErrors(errors)).toBe(false);
  });

  it("maps incomplete coverage to the coefficient aggregate", () => {
    const errors = validateContractedCommit(
      complete({ countShiftTypes: ["D", "N"], countShiftTypeCoefficients: [["D", 16]] }),
      GROUPED,
    );
    expect(errors.coefficientAggregate).toBeDefined();
    expect(errors.coefficientErrorsById).toBeUndefined();
  });

  it("drops an extra (non-selected) coefficient like serialization does (validate ≡ persist)", () => {
    // With only D selected, N is not in the concrete domain, so the sync drops it
    // both in the commit gate and in buildContractedCard — the editor never emits an
    // extra id (the "does not correspond" guard still fires at the producer boundary).
    const draft = complete({
      countShiftTypes: ["D"],
      countShiftTypeCoefficients: [
        ["D", 16],
        ["N", 16],
      ],
    });
    expect(hasContractedErrors(validateContractedCommit(draft, GROUPED))).toBe(false);
    expect(buildContractedCard(draft, GROUPED, "uid-extra").countShiftTypeCoefficients).toEqual([
      ["D", 16],
    ]);
  });

  it("collapses a duplicate coefficient id like serialization does (validate ≡ persist)", () => {
    // The commit gate validates the SAME entry set buildContractedCard persists, and
    // that path syncs pairs to eligible ids (collapsing a repeated id to its first
    // value) — so a duplicate id is a no-op dedup, not a blocking error.
    const draft = complete({
      countShiftTypeCoefficients: [
        ["D", 16],
        ["D", 16],
      ],
    });
    expect(hasContractedErrors(validateContractedCommit(draft, GROUPED))).toBe(false);
    expect(buildContractedCard(draft, GROUPED, "uid-dup").countShiftTypeCoefficients).toEqual([
      ["D", 16],
    ]);
  });

  it("blocks a non-integer coefficient that serialization would drop (P1 regression)", () => {
    // 1.5 satisfies the shared helper's `< 1` check but validateCoefficientPairs drops
    // it on save — the commit gate must catch it so a card with missing coverage can
    // never be written. validate ≡ persist.
    const draft = complete({ countShiftTypeCoefficients: [["D", 1.5]] });
    const errors = validateContractedCommit(draft, GROUPED);
    expect(hasContractedErrors(errors)).toBe(true);
    expect(errors.coefficientErrorsById?.D).toBeDefined();
    // The value serialization would have silently discarded is exactly what's blocked.
    expect(
      buildContractedCard(draft, GROUPED, "uid-nonint").countShiftTypeCoefficients,
    ).toBeUndefined();
  });

  it("maps a below-one coefficient to the per-id slot", () => {
    const errors = validateContractedCommit(
      complete({ countShiftTypeCoefficients: [["D", 0]] }),
      GROUPED,
    );
    expect(errors.coefficientErrorsById?.D).toBeDefined();
  });

  it("still surfaces the range-order field error", () => {
    const errors = validateContractedCommit(
      complete({
        policy: "range",
        targetExact: "",
        targetRangeMin: "170h",
        targetRangeMax: "150h",
      }),
      GROUPED,
    );
    expect(errors.targetRangeMax).toBeDefined();
  });

  it("still surfaces an unparsable target field error", () => {
    const errors = validateContractedCommit(complete({ targetExact: "8h 15m" }), GROUPED);
    expect(errors.targetExact).toBeDefined();
  });
});
