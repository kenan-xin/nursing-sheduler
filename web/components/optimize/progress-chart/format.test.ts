// T16d — pure formatter tests. Node environment; no React, no DOM.
//
// Score formatters use the runtime default locale, so assertions stick to
// properties that hold across locales (numeric prefix, suffix letter class)
// rather than exact en-US strings. The elapsed-seconds formatter is locale-free
// (custom ladder, not Intl-based), so its assertions are exact.

import { describe, expect, it } from "vitest";
import {
  formatCompact,
  formatComments,
  formatElapsedSeconds,
  formatScore,
  formatSolutionIndex,
  MISSING_VALUE_TEXT,
} from "./format";

describe("formatElapsedSeconds — locale-free ladder", () => {
  it("formats sub-10s values with one decimal place", () => {
    expect(formatElapsedSeconds(0)).toBe("0.0s");
    expect(formatElapsedSeconds(2.5)).toBe("2.5s");
    expect(formatElapsedSeconds(9.99)).toBe("10.0s"); // toFixed(1) rounds
  });

  it("formats 10s..60s as rounded seconds", () => {
    expect(formatElapsedSeconds(10)).toBe("10s");
    expect(formatElapsedSeconds(45.4)).toBe("45s");
    expect(formatElapsedSeconds(59.6)).toBe("60s"); // Math.round
  });

  it("formats 1m..1h as 'Xm YYs' with zero-padded seconds", () => {
    expect(formatElapsedSeconds(60)).toBe("1m 00s");
    expect(formatElapsedSeconds(125)).toBe("2m 05s");
    expect(formatElapsedSeconds(3599)).toBe("59m 59s");
  });

  it("rounds the total before decomposing so no seconds remainder hits 60", () => {
    // Regression: rounding only the `value % 60` remainder rendered 3599.5 as
    // "59m 60s"; rounding the total carries it to the hour boundary instead.
    expect(formatElapsedSeconds(3599.5)).toBe("1h 00m");
    expect(formatElapsedSeconds(119.5)).toBe("2m 00s");
    expect(formatElapsedSeconds(89.6)).toBe("1m 30s");
  });

  it("formats ≥1h as 'Xh YYm' with zero-padded minutes", () => {
    expect(formatElapsedSeconds(3600)).toBe("1h 00m");
    expect(formatElapsedSeconds(5400)).toBe("1h 30m");
    expect(formatElapsedSeconds(86_400)).toBe("24h 00m");
  });
});

describe("formatComments / formatSolutionIndex — nullable field placeholders", () => {
  it("renders the required N/A placeholder (not a dash) for missing values", () => {
    expect(MISSING_VALUE_TEXT).toBe("N/A");
    expect(formatComments(null)).toBe("N/A");
    expect(formatSolutionIndex(null)).toBe("N/A");
    expect(formatComments(Number.NaN)).toBe("N/A");
    expect(formatSolutionIndex(Number.NaN)).toBe("N/A");
  });

  it("renders present values (comment count formatted, solution index prefixed)", () => {
    expect(formatComments(0)).toMatch(/^0/);
    expect(formatComments(12)).toMatch(/^12/);
    expect(formatSolutionIndex(0)).toBe("#0");
    expect(formatSolutionIndex(7)).toBe("#7");
  });
});

describe("formatScore — locale-aware but structurally stable", () => {
  it("formats a small integer without scientific notation", () => {
    const out = formatScore(42);
    expect(out).toMatch(/^42(\D|$)/);
    expect(out).not.toMatch(/[eE]/);
  });

  it("groups thousands (some separator appears for 1000)", () => {
    const out = formatScore(1000);
    expect(out.replace(/\D/g, "")).toBe("1000");
    expect(out.length).toBeGreaterThan(4);
  });

  it("caps fractional digits at 2", () => {
    expect(formatScore(3.14159)).toMatch(/^3\.14\D?$/);
    expect(formatScore(2.5)).toMatch(/^2\.5\D?$/);
  });

  it("preserves the minus sign for negative scores (CP-SAT produces them)", () => {
    expect(formatScore(-12.345)).toMatch(/^-12\.3[0-9]?\D?$/);
  });
});

describe("formatCompact — locale-aware but structurally stable", () => {
  it("returns a short string for thousands (≤5 chars in most locales)", () => {
    const out = formatCompact(12_345);
    expect(out.length).toBeLessThanOrEqual(6);
    expect(out).toMatch(/12/i);
  });

  it("returns a short string for millions", () => {
    const out = formatCompact(2_500_000);
    expect(out.length).toBeLessThanOrEqual(6);
    expect(out).toMatch(/^2\.?5?/i);
  });

  it("uses at most one fractional digit", () => {
    const out = formatCompact(1234);
    // Either "1K" or "1.2K"-ish; never more than one digit after a decimal point.
    if (out.includes(".") || out.includes(",")) {
      const frac = out.split(/[.,]/)[1] ?? "";
      // Allow the suffix letter at the end of the fractional part.
      expect(frac.replace(/[^\d]/g, "").length).toBeLessThanOrEqual(1);
    }
  });
});
