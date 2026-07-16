// Shared zod primitives for the producer and import schemas (T05).
//
// zod 4 note: simple error customization uses the `error` key (the v3 `message`
// key is deprecated); unknown-key policy is chosen per-object via `z.strictObject`
// (producer, reject extras) vs `z.object` (import, strip extras). These live in
// one place so the two schemas stay faithful to the same backend primitive shapes
// (core/nurse_scheduling/models.py).

import { z } from "zod";

/** A person / people-group / date / shift-type id reference (`int | str`). The
 *  backend rejects fractional ids (`int_from_float`), so numeric refs are ints. */
export const zRef = z.union([z.number().int(), z.string()]);

/** A shift-type *selector* is always a string in the backend preference models. */
export const zShiftTypeSelector = z.string();

/**
 * A preference weight: an integer soft weight, or the only permitted non-integers
 * `Infinity` / `-Infinity` (hard constraints). Mirrors `models.validate_weight`
 * (a float weight may only be `.inf` / `-.inf`). zod 4's `z.number()` rejects
 * non-finite values, so the infinities are matched by explicit literals.
 */
export const zWeight = z.union([z.number().int(), z.literal(Infinity), z.literal(-Infinity)]);

/** A number that also tolerates `±Infinity` (backend `int | float`, e.g. export
 *  `weightRange`, which — unlike a preference weight — is unrestricted). */
export const zLooseNumber = z.union([z.number(), z.literal(Infinity), z.literal(-Infinity)]);

/** Six-hex-digit `#rrggbb` color string (mirrors the backend color pattern). */
export const zHexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, {
  error: "Color must be a six-digit hex string like '#1a2b3c'.",
});

/** 30-minute-grid `"HH:00"` / `"HH:30"` clock time (backend `ShiftType` pattern). */
export const CLOCK_GRID_PATTERN = /^([01]\d|2[0-3]):(00|30)$/;
export const zClock = z.string().regex(CLOCK_GRID_PATTERN, {
  error: "Clock time must be on the 30-minute grid, e.g. '09:00' or '13:30'.",
});

/** A `[shiftTypeId, coefficient]` pair — the backend's `tuple[str, int]`. */
export const zCoefficientEntry = z.tuple([z.string(), z.number().int()]);

/** A scalar ref or a list of refs (the backend `X | list[X]` selector shape). */
export const zRefOrList = z.union([zRef, z.array(zRef)]);
export const zShiftSelectorOrList = z.union([zShiftTypeSelector, z.array(zShiftTypeSelector)]);

/** A nested ref list: `list[X | list[X]]` (aggregate groups inside a selector). */
export const zNestedRefList = z.array(z.union([zRef, z.array(zRef)]));
export const zNestedShiftRefList = z.array(
  z.union([zShiftTypeSelector, z.array(zShiftTypeSelector)]),
);

/** A calendar-valid ISO `YYYY-MM-DD` date string. Uses zod 4's `z.iso.date()`,
 *  which rejects impossible dates like `2026-99-99` (a bare regex would not). */
export const zIsoDate = z.iso.date();
