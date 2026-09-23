// The weight dial's pure contract (parse / validate / format), moved verbatim out of
// `weight-field.tsx` so React-free callers -- the rule models and the assistant's host
// operations in `lib/proposal` -- can share it. `weight-field.tsx` re-exports every name,
// so none of its importers change.

/** A weight field's value — see the file header for the `number | string` contract. */
export type WeightFieldValue = number | string;

const INFINITY_TOKENS = ["∞", "+∞", "inf", "+inf", "infinity", "+infinity"];
const NEG_INFINITY_TOKENS = ["-∞", "-inf", "-infinity"];
const SUFFIX_MULTIPLIERS: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };

/**
 * Parse raw weight text exactly like the historical `parseWeightValue`:
 * case-insensitive infinity spellings; a numeric string with a k/m/b/t suffix is
 * multiplied and, when the result is an integer, rounded to that integer
 * (otherwise the raw text is kept); otherwise `parseInt` is applied and, on `NaN`,
 * the raw text is kept (EDGE-PR-09).
 */
export function parseWeightInput(raw: string): WeightFieldValue {
  const lower = raw.toLowerCase();
  if (INFINITY_TOKENS.includes(lower)) return Infinity;
  if (NEG_INFINITY_TOKENS.includes(lower)) return -Infinity;
  const suffix = raw.match(/^([+-]?\d+(?:\.\d+)?)([kmbt])$/i);
  if (suffix) {
    const multiplier = SUFFIX_MULTIPLIERS[suffix[2].toLowerCase()];
    const result = Number.parseFloat(suffix[1]) * multiplier;
    return Number.isInteger(result) ? Math.round(result) : raw;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? raw : parsed;
}

/** Whether a weight value is valid: a finite number or exactly `Infinity`/`-Infinity`
 *  — any raw (unparsed) string is invalid (`isValidWeightValue` ground truth). */
export function isValidWeightValue(value: WeightFieldValue): value is number {
  return typeof value === "number" && (Number.isFinite(value) || Math.abs(value) === Infinity);
}

/** Whether a valid numeric weight is `<= 0` (`isWeightNonPositive` ground truth). */
export function isWeightNonPositive(value: number): boolean {
  return value <= 0;
}

/**
 * Format a valid weight for display: a leading `+` on positive values (incl.
 * `+∞`), thousands separators via `toLocaleString` (which also renders the
 * infinities as `∞`/`-∞`). Mirrors `getWeightWithPositivePrefix`. An invalid
 * (string) draft renders as `Error` — callers should not normally reach this on a
 * saved card, only on a live invalid draft.
 */
export function formatWeight(value: WeightFieldValue): string {
  if (typeof value !== "number") return "Error";
  const text = value.toLocaleString();
  return value > 0 ? `+${text}` : text;
}
