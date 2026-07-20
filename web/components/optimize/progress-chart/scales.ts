// T16d — pure linear scale + tick generation, decoupled from React / DOM.
//
// The chart owns two linear axes (x = elapsedSeconds, y = score or comment
// count). They share a `LinearScale` mapping that is deterministic and
// numerically stable for degenerate domains (single-point, zero-span, negative
// ranges) — the chart never emits NaN pixel coordinates.
//
// `autoDomain` mirrors what recharts' `domain={['auto','auto']}` produced for
// the old chart: the extent of the visible data, padded slightly so the
// extreme points don't sit on the plot edge.

export interface Domain {
  min: number;
  max: number;
}

export interface LinearScale {
  readonly min: number;
  readonly max: number;
  readonly pixelMin: number;
  readonly pixelSpan: number;
  readonly domainSpan: number;
}

/**
 * Build a linear scale mapping [domainMin, domainMax] → [pixelMin, pixelMin + pixelSpan].
 * Defends against non-finite inputs and zero-span domains so downstream pixel
 * math is always finite.
 */
export function createLinearScale(
  domainMin: number,
  domainMax: number,
  pixelMin: number,
  pixelMax: number,
): LinearScale {
  const finiteDomainMin = Number.isFinite(domainMin) ? domainMin : 0;
  const finiteDomainMax = Number.isFinite(domainMax) ? domainMax : finiteDomainMin + 1;
  const safeDomainMin = Math.min(finiteDomainMin, finiteDomainMax);
  const safeDomainMax = Math.max(finiteDomainMin, finiteDomainMax);
  const domainSpan = Math.max(safeDomainMax - safeDomainMin, 1e-9);
  const pixelSpan = Math.max(pixelMax - pixelMin, 0);
  return {
    min: safeDomainMin,
    max: safeDomainMax,
    pixelMin,
    pixelSpan,
    domainSpan,
  };
}

/** Map a domain value to its pixel position, clamped to the scale range. */
export function scaleToPixel(scale: LinearScale, value: number): number {
  // Degenerate domain (min === max): collapse to the pixel-range midpoint so a
  // single data point sits in the center of the plot rather than at an edge.
  if (scale.domainSpan <= 1e-9) {
    return scale.pixelMin + scale.pixelSpan / 2;
  }
  if (scale.pixelSpan === 0) return scale.pixelMin;
  const clamped = Math.max(scale.min, Math.min(scale.max, value));
  const ratio = (clamped - scale.min) / scale.domainSpan;
  return scale.pixelMin + ratio * scale.pixelSpan;
}

/** Map a pixel position back to a domain value (unclamped). */
export function pixelToScale(scale: LinearScale, pixel: number): number {
  if (scale.pixelSpan === 0) return scale.min;
  const ratio = (pixel - scale.pixelMin) / scale.pixelSpan;
  return scale.min + ratio * scale.domainSpan;
}

/**
 * Compute a small-padded extent of a numeric series. Returns `{ min: 0, max: 1 }`
 * for an empty or all-non-finite input so the caller never feeds a degenerate
 * domain to `createLinearScale`. Single-distinct-value inputs are padded
 * symmetrically so the value sits at the plot midpoint, not on an edge.
 *
 * `floorAtZero` anchors the bottom at `min(0, data_min)` — used for the
 * comment-count axis where negative counts are meaningless. The top still gets
 * a small pad so the max point doesn't sit on the plot edge.
 */
export function autoDomain(values: readonly number[], floorAtZero = false): Domain {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: 1 };
  }
  if (min === max) {
    const pad = Math.max(Math.abs(min) * 0.1, 1);
    if (floorAtZero) {
      // Anchor the bottom at min(0, value) — matching the multi-value branch —
      // and pad only the top. Clamping the padded *min* up to 0 (the previous
      // behavior) inverted the domain for a lone negative value, e.g.
      // autoDomain([-5], true) → { min: 0, max: -4 }.
      return { min: Math.min(0, min), max: max + pad };
    }
    return { min: min - pad, max: max + pad };
  }
  const pad = (max - min) * 0.05;
  if (floorAtZero) {
    // Hard floor at min(0, data_min) — padding never pushes the bottom lower.
    return { min: Math.min(0, min), max: max + pad };
  }
  return { min: min - pad, max: max + pad };
}

/**
 * A "nice" tick generator for arbitrary numeric domains. Produces 4–6 ticks at
 * nice intervals (1, 2, 5 × 10ⁿ) so axes don't render values like 7.342193.
 * Returns an empty array if either bound is non-finite or the domain is zero.
 */
export function generateTicks(domainMin: number, domainMax: number, targetCount = 5): number[] {
  if (!Number.isFinite(domainMin) || !Number.isFinite(domainMax) || domainMin === domainMax) {
    return [];
  }
  const range = domainMax - domainMin;
  const roughStep = range / Math.max(targetCount, 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const normalized = roughStep / magnitude;
  let niceStep: number;
  if (normalized < 1.5) niceStep = 1 * magnitude;
  else if (normalized < 3) niceStep = 2 * magnitude;
  else if (normalized < 7) niceStep = 5 * magnitude;
  else niceStep = 10 * magnitude;

  const ticks: number[] = [];
  // Floating-point epsilon guard so a tick exactly at domainMax is included.
  const epsilon = niceStep * 1e-6;
  const start = Math.ceil(domainMin / niceStep) * niceStep;
  for (let v = start; v <= domainMax + epsilon; v += niceStep) {
    ticks.push(Number(v.toFixed(8)));
  }
  return ticks;
}
