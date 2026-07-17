import { describe, expect, it } from "vitest";
import {
  formatWeight,
  isValidWeightValue,
  isWeightNonPositive,
  parseWeightInput,
} from "./weight-field";

describe("parseWeightInput (parity with the historical parseWeightValue)", () => {
  it("parses case-insensitive infinity spellings", () => {
    expect(parseWeightInput("Infinity")).toBe(Infinity);
    expect(parseWeightInput("inf")).toBe(Infinity);
    expect(parseWeightInput("∞")).toBe(Infinity);
    expect(parseWeightInput("+INFINITY")).toBe(Infinity);
    expect(parseWeightInput("-infinity")).toBe(-Infinity);
    expect(parseWeightInput("-inf")).toBe(-Infinity);
    expect(parseWeightInput("-∞")).toBe(-Infinity);
  });

  it("applies a k/m/b/t suffix multiplier when the result is an integer", () => {
    expect(parseWeightInput("1.5k")).toBe(1500);
    expect(parseWeightInput("2m")).toBe(2_000_000);
    expect(parseWeightInput("-3b")).toBe(-3_000_000_000);
  });

  it("keeps the raw text when a suffixed result is not an integer (EDGE-PR-09)", () => {
    expect(parseWeightInput("1.23456k")).toBe("1.23456k");
  });

  it("parses a plain integer string", () => {
    expect(parseWeightInput("-50")).toBe(-50);
    expect(parseWeightInput("10")).toBe(10);
  });

  it("keeps unparseable text verbatim (invalid, caught at validate time)", () => {
    expect(parseWeightInput("abc")).toBe("abc");
    expect(parseWeightInput("")).toBe("");
  });

  it("parseInt fallback truncates a trailing non-numeric tail (EDGE-PR-09)", () => {
    expect(parseWeightInput("10abc")).toBe(10);
  });
});

describe("isValidWeightValue / isWeightNonPositive", () => {
  it("accepts finite numbers and both infinities; rejects any string", () => {
    expect(isValidWeightValue(-1)).toBe(true);
    expect(isValidWeightValue(0)).toBe(true);
    expect(isValidWeightValue(Infinity)).toBe(true);
    expect(isValidWeightValue(-Infinity)).toBe(true);
    expect(isValidWeightValue("abc")).toBe(false);
    expect(isValidWeightValue("")).toBe(false);
  });

  it("treats <= 0 as non-positive, including -Infinity", () => {
    expect(isWeightNonPositive(0)).toBe(true);
    expect(isWeightNonPositive(-1)).toBe(true);
    expect(isWeightNonPositive(-Infinity)).toBe(true);
    expect(isWeightNonPositive(1)).toBe(false);
    expect(isWeightNonPositive(Infinity)).toBe(false);
  });
});

describe("formatWeight (parity with getWeightWithPositivePrefix)", () => {
  it("prefixes a positive weight with +, including +Infinity", () => {
    expect(formatWeight(50)).toBe("+50");
    expect(formatWeight(Infinity)).toBe("+∞");
  });

  it("renders a negative/zero weight without a prefix", () => {
    expect(formatWeight(-50)).toBe("-50");
    expect(formatWeight(0)).toBe("0");
    expect(formatWeight(-Infinity)).toBe("-∞");
  });

  it("renders an invalid (string) draft as Error", () => {
    expect(formatWeight("abc")).toBe("Error");
  });
});
