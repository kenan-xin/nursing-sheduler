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

// The load-bearing guarantee is byte-identical output to the former inline
// producer validator, so every assertion locks the FULL ordered `errors` array
// (no extra/missing/misordered issues) and the exact `expanded` set — not merely
// "this one error appears". Each `ContractedHoursError` maps 1:1 to the Zod path
// suffix the adapter emits (see producer.test.ts for the adapter-level path lock).
const INCOMPLETE_COVERAGE =
  "A contracted-hours shift count must list an explicit coefficient for every selected shift type (including LEAVE); coverage is incomplete.";

function expectErrors(actual: ContractedHoursError[], expected: ContractedHoursError[]): void {
  expect(actual).toEqual(expected);
}

describe("validateContractedHoursContract — valid payloads", () => {
  it("accepts a valid Exact contract and reports the selected worked set", () => {
    const { errors, expanded } = run({});
    expectErrors(errors, []);
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
    expectErrors(errors, []);
    expect(expanded).toEqual([0]);
  });

  it("accepts an ALL selector with full worked coverage", () => {
    const { errors, expanded } = run({
      countShiftTypes: ["ALL"],
      countShiftTypeCoefficients: [
        ["D", 1],
        ["E", 1],
        ["N", 1],
      ],
    });
    expectErrors(errors, []);
    expect(expanded).toEqual([0, 1, 2]);
  });

  it("accepts LEAVE as a covered day-state (sorted below worked ids)", () => {
    const { errors, expanded } = run({
      countShiftTypes: ["D", "LEAVE"],
      countShiftTypeCoefficients: [
        ["D", 1],
        ["LEAVE", 16],
      ],
    });
    expectErrors(errors, []);
    expect(expanded).toEqual([-2, 0]);
  });
});

describe("validateContractedHoursContract — selectors", () => {
  it("rejects empty selectors and returns before coverage runs", () => {
    const { errors, expanded } = run({ countShiftTypes: [], countShiftTypeCoefficients: [] });
    expectErrors(errors, [
      {
        field: "countShiftTypes",
        message: "A contracted-hours shift count requires non-empty countShiftTypes.",
      },
    ]);
    expect(expanded).toEqual([]);
  });

  it("short-circuits on an unknown selector but keeps the resolved partial expansion", () => {
    const { errors, expanded } = run({
      countShiftTypes: ["D", "ZZZ"],
      countShiftTypeCoefficients: [["D", 1]],
    });
    expectErrors(errors, [{ field: "countShiftTypes", message: "Unknown shift type ID: ZZZ" }]);
    expect(expanded).toEqual([0]);
  });

  it("rejects OFF as a selected shift type (plus the incomplete coverage it leaves)", () => {
    const { errors, expanded } = run({
      countShiftTypes: ["OFF"],
      countShiftTypeCoefficients: [],
    });
    expectErrors(errors, [
      {
        field: "countShiftTypes",
        message: "'OFF' is not allowed in a contracted-hours shift count.",
      },
      { field: "countShiftTypeCoefficients", message: INCOMPLETE_COVERAGE },
    ]);
    expect(expanded).toEqual([-1]);
  });
});

describe("validateContractedHoursContract — coverage bijection", () => {
  it("flags incomplete coverage when a selected shift type has no coefficient", () => {
    const { errors } = run({ countShiftTypeCoefficients: [["D", 1]] });
    expectErrors(errors, [{ field: "countShiftTypeCoefficients", message: INCOMPLETE_COVERAGE }]);
  });

  it("flags a coefficient that does not correspond to any selected shift type", () => {
    const { errors } = run({
      countShiftTypes: ["D"],
      countShiftTypeCoefficients: [
        ["D", 1],
        ["E", 1],
      ],
    });
    expectErrors(errors, [
      {
        field: "countShiftTypeCoefficients",
        message: "A contracted-hours coefficient does not correspond to any selected shift type.",
      },
    ]);
  });

  it("flags a duplicate coefficient", () => {
    const { errors } = run({
      countShiftTypes: ["D"],
      countShiftTypeCoefficients: [
        ["D", 1],
        ["D", 1],
      ],
    });
    expectErrors(errors, [
      {
        field: "countShiftTypeCoefficients",
        message: "Duplicate contracted-hours coefficient for 'D'.",
        shiftTypeId: "D",
      },
    ]);
  });

  it("flags a coefficient below 1 (and the incomplete coverage its skip leaves)", () => {
    const { errors } = run({
      countShiftTypes: ["D"],
      countShiftTypeCoefficients: [["D", 0]],
    });
    expectErrors(errors, [
      {
        field: "countShiftTypeCoefficients",
        message: "Contracted-hours coefficient for 'D' must be at least 1.",
        shiftTypeId: "D",
      },
      { field: "countShiftTypeCoefficients", message: INCOMPLETE_COVERAGE },
    ]);
  });

  it("flags an unknown coefficient id", () => {
    const { errors } = run({
      countShiftTypes: ["D"],
      countShiftTypeCoefficients: [
        ["D", 1],
        ["ZZZ", 1],
      ],
    });
    expectErrors(errors, [
      {
        field: "countShiftTypeCoefficients",
        message: "Unknown shift type ID: ZZZ",
        shiftTypeId: "ZZZ",
      },
    ]);
  });
});

describe("validateContractedHoursContract — reserved / group selectors", () => {
  it("rejects OFF as a coefficient id", () => {
    const { errors } = run({
      countShiftTypes: ["D"],
      countShiftTypeCoefficients: [
        ["D", 1],
        ["OFF", 1],
      ],
    });
    expectErrors(errors, [
      {
        field: "countShiftTypeCoefficients",
        message: "'OFF' is not allowed in a contracted-hours shift count.",
        shiftTypeId: "OFF",
      },
    ]);
  });

  it("rejects a group / ALL as a coefficient id", () => {
    const { errors } = run({
      countShiftTypes: ["D"],
      countShiftTypeCoefficients: [
        ["D", 1],
        ["grp", 1],
      ],
    });
    expectErrors(errors, [
      {
        field: "countShiftTypeCoefficients",
        message:
          "Contracted-hours coefficient 'grp' must be a concrete shift type or 'LEAVE', not a group or 'ALL'.",
        shiftTypeId: "grp",
      },
    ]);
  });
});

describe("validateContractedHoursContract — policy encoding", () => {
  it("rejects an Exact contract with an array target", () => {
    const { errors } = run({ policy: "exact", target: [1, 5] });
    expectErrors(errors, [
      {
        field: "target",
        message: "An exact contracted-hours shift count must use a scalar target.",
      },
    ]);
  });

  it("rejects a negative Exact target", () => {
    const { errors } = run({ policy: "exact", target: -1 });
    expectErrors(errors, [
      {
        field: "target",
        message: "Contracted-hours target must be non-negative, but got -1.",
      },
    ]);
  });

  it("rejects a malformed Exact expression", () => {
    const { errors } = run({ policy: "exact", expression: "x >= T" });
    expectErrors(errors, [
      {
        field: "expression",
        message: "An exact contracted-hours shift count must use expression 'x = T'.",
      },
    ]);
  });

  it("rejects a malformed Range expression", () => {
    const { errors } = run({
      policy: "range",
      expression: "x = T",
      target: [1, 5],
      countShiftTypes: ["D"],
      countShiftTypeCoefficients: [["D", 1]],
    });
    expectErrors(errors, [
      {
        field: "expression",
        message: "A range contracted-hours shift count must use expression ['x >= T', 'x <= T'].",
      },
    ]);
  });

  it("rejects a Range contract with min > max", () => {
    const { errors } = run({
      policy: "range",
      expression: ["x >= T", "x <= T"],
      target: [5, 1],
    });
    expectErrors(errors, [
      {
        field: "target",
        message: "Contracted-hours range minimum must not exceed maximum, but got [5, 1].",
      },
    ]);
  });

  it("rejects a Range contract with a negative bound", () => {
    const { errors } = run({
      policy: "range",
      expression: ["x >= T", "x <= T"],
      target: [-1, 5],
    });
    expectErrors(errors, [
      {
        field: "target",
        message: "Contracted-hours range targets must be non-negative, but got [-1, 5].",
      },
    ]);
  });

  it("rejects a Range contract with a one-element target", () => {
    const { errors } = run({
      policy: "range",
      expression: ["x >= T", "x <= T"],
      target: [5],
    });
    expectErrors(errors, [
      {
        field: "target",
        message:
          "A range contracted-hours shift count must use a two-element [minimum, maximum] target.",
      },
    ]);
  });

  it("rejects a non-Infinity weight", () => {
    const { errors } = run({ weight: 1 });
    expectErrors(errors, [
      {
        field: "weight",
        message: "A contracted-hours shift count must use weight '.inf', but got 1.",
      },
    ]);
  });
});

describe("validateContractedHoursContract — compound ordering", () => {
  it("emits weight, then policy, then coverage errors in that fixed order", () => {
    const { errors } = run({
      weight: 1,
      policy: "exact",
      target: [1, 5],
      countShiftTypes: ["D", "E"],
      countShiftTypeCoefficients: [["D", 1]],
    });
    expectErrors(errors, [
      {
        field: "weight",
        message: "A contracted-hours shift count must use weight '.inf', but got 1.",
      },
      {
        field: "target",
        message: "An exact contracted-hours shift count must use a scalar target.",
      },
      { field: "countShiftTypeCoefficients", message: INCOMPLETE_COVERAGE },
    ]);
  });
});
