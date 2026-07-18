import { describe, expect, it } from "vitest";
import type {
  AffinityCard,
  CountCard,
  CoveringCard,
  RequirementCard,
  SuccessionCard,
} from "@/lib/scenario";
import {
  affinitiesMapper,
  countsMapper,
  coveringsMapper,
  requirementsMapper,
  successionsMapper,
} from "./mappers";

describe("requirementsMapper", () => {
  const supported: RequirementCard = {
    uid: "r1",
    shiftType: "D",
    requiredNumPeople: 2,
    weight: -1,
  };
  const unsupported: RequirementCard = {
    uid: "r2",
    shiftType: ["D", "N"],
    requiredNumPeople: 1,
    weight: -1,
  };

  it("declares requiredNumPeople as the sole quick field for a single-shift-type card", () => {
    expect(requirementsMapper.unsupportedReason(supported)).toBeUndefined();
    const fields = requirementsMapper.quickFields(supported);
    expect(fields.map((f) => f.key)).toEqual(["requiredNumPeople"]);
    expect(fields[0].value).toBe(2);
  });

  it("falls back to a generated title when description is absent", () => {
    expect(requirementsMapper.defaultTitle(supported)).toContain("D");
  });

  it("uses the card's own description as the title when present", () => {
    expect(requirementsMapper.defaultTitle({ ...supported, description: "Day cap" })).toBe(
      "Day cap",
    );
  });

  it("marks a multi-shift-type requirement unsupported with no quick fields", () => {
    expect(requirementsMapper.unsupportedReason(unsupported)).toBeDefined();
    expect(requirementsMapper.quickFields(unsupported)).toEqual([]);
  });

  it("validates requiredNumPeople via the model's own message", () => {
    const field = requirementsMapper.quickFields(supported)[0];
    expect(field.validate(3)).toBeUndefined();
    expect(field.validate(-1)).toBeDefined();
  });

  it("applyQuickField writes requiredNumPeople only", () => {
    const next = requirementsMapper.applyQuickField(supported, "requiredNumPeople", 5);
    expect(next.requiredNumPeople).toBe(5);
    expect(requirementsMapper.applyQuickField(supported, "bogus", 5)).toBe(supported);
  });

  it("rename writes the card's description", () => {
    expect(requirementsMapper.rename(supported, "New title").description).toBe("New title");
  });
});

describe("successionsMapper", () => {
  const supported: SuccessionCard = {
    uid: "s1",
    person: ["P1"],
    pattern: ["N", "D"],
    weight: 1,
  };
  const advanced: SuccessionCard = {
    uid: "s2",
    person: ["P1"],
    pattern: [["N", "E"], "D"],
    weight: 1,
  };

  it("declares weight as the sole quick field for a scalar pattern", () => {
    expect(successionsMapper.unsupportedReason(supported)).toBeUndefined();
    expect(successionsMapper.quickFields(supported).map((f) => f.key)).toEqual(["weight"]);
  });

  it("marks a nested-aggregate pattern unsupported", () => {
    expect(successionsMapper.unsupportedReason(advanced)).toBeDefined();
    expect(successionsMapper.quickFields(advanced)).toEqual([]);
  });

  it("summary renders the pattern arrow sequence", () => {
    expect(successionsMapper.summary(supported)).toContain("N → D");
  });

  it("validates weight via isValidWeightValue", () => {
    const field = successionsMapper.quickFields(supported)[0];
    expect(field.validate(Infinity)).toBeUndefined();
    expect(field.validate(Number.NaN)).toBeDefined();
  });
});

describe("countsMapper", () => {
  const supported: CountCard = {
    uid: "c1",
    person: "ALL",
    countDates: "ALL",
    countShiftTypes: "N",
    expression: "x >= T",
    target: 2,
    weight: 1,
  };
  const contracted: CountCard = {
    uid: "c2",
    person: "ALL",
    countDates: "ALL",
    countShiftTypes: "N",
    expression: "x >= T",
    target: 160,
    weight: 1,
    tag: "contracted_hours",
    policy: "exact",
  };
  const advancedArray: CountCard = {
    uid: "c3",
    person: "ALL",
    countDates: "ALL",
    countShiftTypes: "N",
    expression: ["x >= T", "x <= T"],
    target: [1, 5],
    weight: 1,
  };

  it("declares target as the sole quick field for a scalar count", () => {
    expect(countsMapper.unsupportedReason(supported)).toBeUndefined();
    expect(countsMapper.quickFields(supported).map((f) => f.key)).toEqual(["target"]);
  });

  it("marks a contracted-hours card unsupported", () => {
    expect(countsMapper.unsupportedReason(contracted)).toBeDefined();
    expect(countsMapper.quickFields(contracted)).toEqual([]);
  });

  it("marks an unmarked generic-array count unsupported", () => {
    expect(countsMapper.unsupportedReason(advancedArray)).toBeDefined();
    expect(countsMapper.quickFields(advancedArray)).toEqual([]);
  });

  it("validates target as a non-negative integer", () => {
    const field = countsMapper.quickFields(supported)[0];
    expect(field.validate(3)).toBeUndefined();
    expect(field.validate(-1)).toBeDefined();
    expect(field.validate(1.5)).toBeDefined();
  });

  it("applyQuickField only rewrites a scalar target", () => {
    expect(countsMapper.applyQuickField(supported, "target", 9).target).toBe(9);
    // A contracted/advanced card is never routed here by a caller that checks
    // quickFields first, but the adapter itself must stay a safe no-op.
    expect(countsMapper.applyQuickField(contracted, "target", 9)).toBe(contracted);
  });
});

describe("affinitiesMapper", () => {
  const supported: AffinityCard = {
    uid: "a1",
    date: "ALL",
    people1: ["P1"],
    people2: ["P2"],
    shiftTypes: ["D"],
    weight: 1,
  };
  const advanced: AffinityCard = {
    uid: "a2",
    date: "ALL",
    people1: [["P1"], ["P3"]],
    people2: ["P2"],
    shiftTypes: ["D"],
    weight: 1,
  };

  it("declares weight as the sole quick field for a single-term affinity", () => {
    expect(affinitiesMapper.unsupportedReason(supported)).toBeUndefined();
    expect(affinitiesMapper.quickFields(supported).map((f) => f.key)).toEqual(["weight"]);
  });

  it("marks a multi-term affinity unsupported", () => {
    expect(affinitiesMapper.unsupportedReason(advanced)).toBeDefined();
    expect(affinitiesMapper.quickFields(advanced)).toEqual([]);
  });
});

describe("coveringsMapper", () => {
  const supported: CoveringCard = {
    uid: "v1",
    preceptors: ["P1"],
    preceptees: ["P2"],
    shiftTypes: ["D"],
    weight: 1,
  };
  const advanced: CoveringCard = {
    uid: "v2",
    preceptors: [["P1"], ["P3"]],
    preceptees: ["P2"],
    shiftTypes: ["D"],
    weight: 1,
  };

  it("never declares a quick field — weight is a structural constant", () => {
    expect(coveringsMapper.quickFields(supported)).toEqual([]);
    expect(coveringsMapper.unsupportedReason(supported)).toBeUndefined();
  });

  it("marks a multi-term covering unsupported", () => {
    expect(coveringsMapper.unsupportedReason(advanced)).toBeDefined();
  });

  it("applyQuickField is always a no-op", () => {
    expect(coveringsMapper.applyQuickField(supported, "weight", 5)).toBe(supported);
  });
});
