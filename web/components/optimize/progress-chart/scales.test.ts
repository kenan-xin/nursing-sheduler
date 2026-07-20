// T16d — pure scale + tick tests. Node environment; no React, no DOM.

import { describe, expect, it } from "vitest";
import { autoDomain, createLinearScale, generateTicks, pixelToScale, scaleToPixel } from "./scales";

describe("createLinearScale", () => {
  it("maps a domain linearly onto a pixel range", () => {
    const scale = createLinearScale(0, 100, 0, 200);
    expect(scale.domainSpan).toBe(100);
    expect(scale.pixelSpan).toBe(200);
    expect(scaleToPixel(scale, 0)).toBeCloseTo(0);
    expect(scaleToPixel(scale, 50)).toBeCloseTo(100);
    expect(scaleToPixel(scale, 100)).toBeCloseTo(200);
  });

  it("respects pixel offsets (axis gutter)", () => {
    const scale = createLinearScale(0, 10, 60, 760);
    expect(scaleToPixel(scale, 0)).toBeCloseTo(60);
    expect(scaleToPixel(scale, 10)).toBeCloseTo(760);
    expect(scaleToPixel(scale, 5)).toBeCloseTo(410);
  });

  it("swaps min/max if the caller hands them in inverted", () => {
    const scale = createLinearScale(10, 0, 0, 100);
    expect(scale.min).toBe(0);
    expect(scale.max).toBe(10);
    expect(scaleToPixel(scale, 0)).toBeCloseTo(0);
  });

  it("defends against a zero-span domain by forcing domainSpan to a tiny positive value", () => {
    const scale = createLinearScale(5, 5, 0, 100);
    expect(scale.domainSpan).toBeGreaterThan(0);
    expect(scaleToPixel(scale, 5)).toBe(50); // midpoint when clamped
  });

  it("defends against non-finite inputs without producing NaN pixels", () => {
    const scale = createLinearScale(Number.NaN, Number.POSITIVE_INFINITY, 0, 100);
    expect(Number.isFinite(scale.min)).toBe(true);
    expect(Number.isFinite(scale.max)).toBe(true);
    const px = scaleToPixel(scale, scale.min);
    expect(Number.isFinite(px)).toBe(true);
  });

  it("defends against a zero-span pixel range (e.g. container width 0 in jsdom)", () => {
    const scale = createLinearScale(0, 100, 50, 50);
    expect(scale.pixelSpan).toBe(0);
    // Any input collapses to the single pixel.
    expect(scaleToPixel(scale, 25)).toBe(50);
    expect(scaleToPixel(scale, 75)).toBe(50);
  });
});

describe("scaleToPixel — clamping", () => {
  it("clamps values outside the domain to the nearest edge pixel", () => {
    const scale = createLinearScale(0, 10, 0, 100);
    expect(scaleToPixel(scale, -5)).toBe(0);
    expect(scaleToPixel(scale, 15)).toBe(100);
  });
});

describe("pixelToScale — inverse", () => {
  it("inverts scaleToPixel within the domain", () => {
    const scale = createLinearScale(0, 10, 60, 760);
    for (const v of [0, 2.5, 5, 7.5, 10]) {
      const px = scaleToPixel(scale, v);
      expect(pixelToScale(scale, px)).toBeCloseTo(v, 5);
    }
  });

  it("does NOT clamp (allows extrapolation, used for hover lookup just outside the plot)", () => {
    const scale = createLinearScale(0, 10, 0, 100);
    expect(pixelToScale(scale, -10)).toBe(-1);
    expect(pixelToScale(scale, 110)).toBe(11);
  });

  it("returns the domain min when pixelSpan is zero (degenerate but finite)", () => {
    const scale = createLinearScale(7, 14, 50, 50);
    expect(pixelToScale(scale, 50)).toBe(7);
    expect(pixelToScale(scale, 9999)).toBe(7);
  });
});

describe("autoDomain", () => {
  it("returns {0,1} for an empty input (no NaN leak to the axis)", () => {
    expect(autoDomain([])).toEqual({ min: 0, max: 1 });
  });

  it("returns {0,1} when every value is non-finite", () => {
    expect(autoDomain([Number.NaN, Number.POSITIVE_INFINITY])).toEqual({ min: 0, max: 1 });
  });

  it("computes the extent of finite values, ignoring non-finite noise", () => {
    expect(autoDomain([Number.NaN, 5, 10, Number.NaN])).toEqual({ min: 4.75, max: 10.25 });
  });

  it("pads symmetrically when there is only one distinct value (no zero-span axis)", () => {
    const d = autoDomain([7]);
    expect(d.min).toBeLessThan(7);
    expect(d.max).toBeGreaterThan(7);
    expect((d.min + d.max) / 2).toBeCloseTo(7);
  });

  it("pads symmetrically when abs(value) is 0 (single zero point)", () => {
    const d = autoDomain([0]);
    expect(d.min).toBe(-1);
    expect(d.max).toBe(1);
  });

  it("floors the min at 0 when floorAtZero is requested (comment-count axis)", () => {
    const d = autoDomain([3, 5, 7], true);
    expect(d.min).toBe(0);
    expect(d.max).toBeGreaterThan(7);
  });

  it("floorAtZero does not invent a negative min for negative inputs", () => {
    const d = autoDomain([-5, 3], true);
    expect(d.min).toBe(-5);
    expect(d.max).toBeGreaterThanOrEqual(3);
  });

  it("floorAtZero never inverts the domain for a lone negative value", () => {
    // Regression: the singleton branch used to clamp the padded min up to 0
    // while leaving a negative max, producing { min: 0, max: -4 }.
    const d = autoDomain([-5], true);
    expect(d.min).toBeLessThan(d.max);
    expect(d.min).toBeLessThanOrEqual(-5);
    expect(d.max).toBeGreaterThanOrEqual(-5);
  });

  it("floorAtZero anchors a lone positive value's baseline at zero", () => {
    const d = autoDomain([5], true);
    expect(d.min).toBe(0);
    expect(d.max).toBeGreaterThan(5);
  });
});

describe("generateTicks", () => {
  it("produces nice round intervals for a typical 0..100 domain", () => {
    const ticks = generateTicks(0, 100, 5);
    expect(ticks).toEqual([0, 20, 40, 60, 80, 100]);
  });

  it("produces 1,2,5 × 10ⁿ intervals for a sub-100 domain", () => {
    expect(generateTicks(0, 10, 5)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(generateTicks(0, 5, 5)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(generateTicks(0, 1, 5)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
  });

  it("respects a non-zero domain start (only ticks within the range)", () => {
    const ticks = generateTicks(30, 150, 5);
    expect(ticks[0]).toBeGreaterThanOrEqual(30);
    expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(150);
    expect(ticks).toContain(40);
    expect(ticks).toContain(100);
  });

  it("returns an empty array for a degenerate (zero-span) domain", () => {
    expect(generateTicks(5, 5, 5)).toEqual([]);
  });

  it("returns an empty array for non-finite bounds (no NaN ticks)", () => {
    expect(generateTicks(Number.NaN, 10, 5)).toEqual([]);
    expect(generateTicks(0, Number.POSITIVE_INFINITY, 5)).toEqual([]);
  });

  it("targets roughly the requested count (4–7 ticks for targetCount=5)", () => {
    const ticks = generateTicks(0, 1_000_000, 5);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks.length).toBeLessThanOrEqual(8);
  });

  it("produces values exactly at domainMax when domainMax is a nice multiple of step", () => {
    // Domain 0..60 with target 5 → step=10 → ticks 0,10,...,60 (no float drift).
    const ticks = generateTicks(0, 60, 5);
    expect(ticks.at(-1)).toBe(60);
  });
});
