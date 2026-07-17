import { describe, expect, it } from "vitest";
import {
  validateContractedHoursContract,
  type ContractedHoursError,
  type ContractedHoursInput,
} from "./contracted-hours";
import { buildShiftTypeIndexMap } from "./shift-type-map";

// D=0, E=1, N=2; group `grp` -> [D, E]; ALL -> [0,1,2]; OFF -> [-1]; LEAVE -> [-2].
const map = buildShiftTypeIndexMap(
  [{ id: "D" }, { id: "E" }, { id: "N" }],
  [{ id: "grp", members: ["D", "E"] }],
);
const groupIds = new Set<unknown>(["grp"]);

function run(
  input: Partial<ContractedHoursInput>,
): ReturnType<typeof validateContractedHoursContract> {
  const base: ContractedHoursInput = {
    weight: Infinity,
    expression: "x = T",
    target: 5,
    policy: "exact",
    countShiftTypes: ["D", "E"],
    countShiftTypeCoefficients: [
      ["D", 1],
      ["E", 1],
    ],
  };
  return validateContractedHoursContract({ ...base, ...input }, map, groupIds);
}

function has(errors: ContractedHoursError[], partial: Partial<ContractedHoursError>): boolean {
  return errors.some((e) =>
    (Object.keys(partial) as (keyof ContractedHoursError)[]).every((k) => e[k] === partial[k]),
  );
}

describe("validateContractedHoursContract — valid payloads", () => {
  it("accepts a valid Exact contract and reports the selected worked set", () => {
    const { errors, expanded } = run({});
    expect(errors).toEqual([]);
    expect(expanded).toEqual([0, 1]);
  });

  it("accepts a valid Range contract", () => {
    const { errors, expanded } = run({
      policy: "range",
      expression: ["x >= T", "x <= T"],
      target: [1, 5],
      countShiftTypes: ["D"],
      countShiftTypeCoefficients: [["D", 1]],
    });
    expect(errors).toEqual([]);
    expect(expanded).toEqual([0]);
  });
});

describe("validateContractedHoursContract — coverage bijection", () => {
  it("flags incomplete coverage when a selected shift type has no coefficient", () => {
    const { errors } = run({ countShiftTypeCoefficients: [["D", 1]] });
    expect(
      has(errors, {
        field: "countShiftTypeCoefficients",
        message:
          "A contracted-hours shift count must list an explicit coefficient for every selected shift type (including LEAVE); coverage is incomplete.",
      }),
    ).toBe(true);
  });

  it("flags a coefficient that does not correspond to any selected shift type", () => {
    const { errors } = run({
      countShiftTypes: ["D"],
      countShiftTypeCoefficients: [
        ["D", 1],
        ["E", 1],
      ],
    });
    expect(
      has(errors, {
        field: "countShiftTypeCoefficients",
        message: "A contracted-hours coefficient does not correspond to any selected shift type.",
      }),
    ).toBe(true);
  });

  it("flags a duplicate coefficient", () => {
    const { errors } = run({
      countShiftTypes: ["D"],
      countShiftTypeCoefficients: [
        ["D", 1],
        ["D", 1],
      ],
    });
    expect(
      has(errors, {
        field: "countShiftTypeCoefficients",
        message: "Duplicate contracted-hours coefficient for 'D'.",
        shiftTypeId: "D",
      }),
    ).toBe(true);
  });

  it("flags a coefficient below 1", () => {
    const { errors } = run({
      countShiftTypes: ["D"],
      countShiftTypeCoefficients: [["D", 0]],
    });
    expect(
      has(errors, {
        field: "countShiftTypeCoefficients",
        message: "Contracted-hours coefficient for 'D' must be at least 1.",
        shiftTypeId: "D",
      }),
    ).toBe(true);
  });
});

describe("validateContractedHoursContract — reserved / group selectors", () => {
  it("rejects OFF as a selected shift type", () => {
    const { errors } = run({
      countShiftTypes: ["OFF"],
      countShiftTypeCoefficients: [],
    });
    expect(
      has(errors, {
        field: "countShiftTypes",
        message: "'OFF' is not allowed in a contracted-hours shift count.",
      }),
    ).toBe(true);
  });

  it("rejects OFF as a coefficient id", () => {
    const { errors } = run({
      countShiftTypes: ["D"],
      countShiftTypeCoefficients: [
        ["D", 1],
        ["OFF", 1],
      ],
    });
    expect(
      has(errors, {
        field: "countShiftTypeCoefficients",
        message: "'OFF' is not allowed in a contracted-hours shift count.",
        shiftTypeId: "OFF",
      }),
    ).toBe(true);
  });

  it("rejects a group / ALL as a coefficient id", () => {
    const { errors } = run({
      countShiftTypes: ["D"],
      countShiftTypeCoefficients: [
        ["D", 1],
        ["grp", 1],
      ],
    });
    expect(
      has(errors, {
        field: "countShiftTypeCoefficients",
        message:
          "Contracted-hours coefficient 'grp' must be a concrete shift type or 'LEAVE', not a group or 'ALL'.",
        shiftTypeId: "grp",
      }),
    ).toBe(true);
  });
});

describe("validateContractedHoursContract — policy encoding", () => {
  it("rejects an Exact contract with an array target", () => {
    const { errors } = run({ policy: "exact", target: [1, 5] });
    expect(
      has(errors, {
        field: "target",
        message: "An exact contracted-hours shift count must use a scalar target.",
      }),
    ).toBe(true);
  });

  it("rejects a Range contract with min > max", () => {
    const { errors } = run({
      policy: "range",
      expression: ["x >= T", "x <= T"],
      target: [5, 1],
    });
    expect(
      has(errors, {
        field: "target",
        message: "Contracted-hours range minimum must not exceed maximum, but got [5, 1].",
      }),
    ).toBe(true);
  });

  it("rejects a Range contract with a one-element target", () => {
    const { errors } = run({
      policy: "range",
      expression: ["x >= T", "x <= T"],
      target: [5] as unknown as [number, number],
    });
    expect(
      has(errors, {
        field: "target",
        message:
          "A range contracted-hours shift count must use a two-element [minimum, maximum] target.",
      }),
    ).toBe(true);
  });

  it("rejects a non-Infinity weight", () => {
    const { errors } = run({ weight: 1 });
    expect(
      has(errors, {
        field: "weight",
        message: "A contracted-hours shift count must use weight '.inf', but got 1.",
      }),
    ).toBe(true);
  });
});
