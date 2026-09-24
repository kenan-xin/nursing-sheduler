import { describe, expect, it } from "vitest";
import { passAtK, passHatK } from "./reliability";

describe("pass^k", () => {
  it("is 1 only when every trial passed", () => {
    expect(passHatK(3, 3, 3)).toBe(1);
    expect(passHatK(3, 2, 3)).toBe(0);
  });
  it("is the unbiased estimator C(c,k)/C(n,k)", () => {
    expect(passHatK(3, 2, 1)).toBeCloseTo(2 / 3);
    expect(passHatK(5, 4, 2)).toBeCloseTo(0.6);
  });
  it("refuses k outside 1..n", () => {
    expect(() => passHatK(3, 3, 4)).toThrow(RangeError);
    expect(() => passHatK(3, 3, 0)).toThrow(RangeError);
  });
});

describe("pass@k", () => {
  it("is 1 - C(n-c,k)/C(n,k)", () => {
    expect(passAtK(3, 1, 2)).toBeCloseTo(2 / 3);
    expect(passAtK(3, 0, 3)).toBe(0);
    expect(passAtK(3, 3, 1)).toBe(1);
  });
});
