import { describe, expect, it } from "vitest";
import {
  EXPRESSION_OPS,
  SUPPORTED_EXPRESSIONS,
  isSquaredExpression,
  isSupportedExpression,
  substituteTarget,
} from "./expression-field";

describe("SUPPORTED_EXPRESSIONS (spec 05 FR-PR-52, AC-PR-12)", () => {
  it("is exactly the six backend expressions, in canonical order", () => {
    expect(SUPPORTED_EXPRESSIONS).toEqual([
      "|x - T|^2",
      "x >= T",
      "x <= T",
      "x > T",
      "x < T",
      "x = T",
    ]);
  });

  it("EXPRESSION_OPS values line up 1:1 with SUPPORTED_EXPRESSIONS", () => {
    expect(EXPRESSION_OPS.map((op) => op.value)).toEqual(SUPPORTED_EXPRESSIONS);
  });

  it("recognizes only the six supported strings", () => {
    expect(isSupportedExpression("x >= T")).toBe(true);
    expect(isSupportedExpression("x != T")).toBe(false);
  });
});

describe("isSquaredExpression", () => {
  it("is true only for the |x - T|^2 form", () => {
    expect(isSquaredExpression("|x - T|^2")).toBe(true);
    expect(isSquaredExpression("x >= T")).toBe(false);
  });
});

describe("substituteTarget (parity with describeExpressionTarget)", () => {
  it("replaces T with the numeric target", () => {
    expect(substituteTarget("x >= T", 5)).toBe("x >= 5");
    expect(substituteTarget("|x - T|^2", 320)).toBe("|x - 320|^2");
  });
});
