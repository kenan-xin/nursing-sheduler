// The fixed eight-entry start-time shift ramp (F4).
//
// DESIGN.md §2 "Shift colour palette" is authoritative: worked shifts are
// coloured BY START TIME, from a fixed 8-entry ramp so mornings read warm and
// nights read cool. Adjacent entries must differ in hue, not just lightness.
// These are LITERAL HEXES, not theme tokens, and DO NOT CHANGE in dark mode —
// they are data marks and must stay comparable across themes.
//
// Reserved and never drawn from this ramp: leave (`--panel`) and rest (a
// `--faint` dot). See `./shift-chip.tsx`.

/**
 * One entry of the fixed ramp. `fill`+`ink` are the chip; `bar` is the legend
 * dot and the Day-view tag colour.
 */
export interface ShiftRampEntry {
  fill: string;
  ink: string;
  bar: string;
}

/**
 * The fixed eight-entry ramp, in order. Index 0 is the warmest (morning);
 * index 7 is the dark overflow.
 *
 * Kept as a readonly tuple of plain objects so a chip can borrow a reference
 * rather than re-resolving per render. The values are the exact hexes from
 * DESIGN.md §2 — never rounded, never tokenized.
 */
export const SHIFT_RAMP: readonly ShiftRampEntry[] = [
  { fill: "#f8e2b8", ink: "#7a5310", bar: "#d4a038" }, // 1 morning — amber
  { fill: "#f6dbcd", ink: "#9a4726", bar: "#cf7049" }, // 2 afternoon/evening — clay
  { fill: "#e4ecd0", ink: "#586a22", bar: "#8fa243" }, // 3 long day — olive
  { fill: "#d8e0f2", ink: "#374777", bar: "#6274ad" }, // 4 night — cool slate
  { fill: "#e9dbf0", ink: "#653f8e", bar: "#9670bd" }, // 5 plum
  { fill: "#d3e9e3", ink: "#1b6a5d", bar: "#3d9587" }, // 6 teal
  { fill: "#f7dae2", ink: "#9a3153", bar: "#c66184" }, // 7 rose
  { fill: "#2b2733", ink: "#ece6f2", bar: "#5c5468" }, // 8 dark (overflow)
] as const;

/** The index of the dark overflow entry — every shift past the seventh lands here. */
const OVERFLOW_INDEX = SHIFT_RAMP.length - 1;

/**
 * Compare two `"HH:MM"` time strings as minutes-since-midnight. A time that
 * crosses midnight (e.g. `"23:00"` vs `"07:00"`) is compared by raw clock value,
 * not by shift-duration semantics: the ramp orders by START time only, and a
 * night shift starting at 21:00 reads cooler than a day starting at 09:00
 * regardless of when it ends.
 */
function compareStartTime(a: string, b: string): number {
  return timeToMinutes(a) - timeToMinutes(b);
}

function timeToMinutes(time: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (match === null) return Number.MAX_SAFE_INTEGER;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Assign each worked shift type a stable ramp position, keyed by start time.
 *
 * The worked shift types are sorted by `startTime` ascending and assigned
 * positions 0..7 in order. A shift with no `startTime` sorts last (it is the
 * least "morning"). More than eight shifts collapse into the dark overflow
 * entry so the ramp never grows past eight — the constraint is a FIXED ramp,
 * not a per-shift palette.
 *
 * The result is keyed by the typed shift id (honoring `number` vs `string`),
 * so two shifts with the same-looking id of different types never collide.
 */
export function assignShiftRamp<TShift extends { id: unknown; startTime?: string }>(
  shiftTypes: readonly TShift[],
): Map<string, ShiftRampEntry> {
  // Pair each shift with its sort key so the sort is stable and the original
  // index breaks ties (two shifts sharing a start time keep their axis order).
  const indexed = shiftTypes.map((shift, index) => ({
    id: typedKey(shift.id),
    startTime: shift.startTime ?? "99:99",
    index,
  }));
  indexed.sort((a, b) => {
    const byTime = compareStartTime(a.startTime, b.startTime);
    return byTime !== 0 ? byTime : a.index - b.index;
  });

  const ramp = new Map<string, ShiftRampEntry>();
  indexed.forEach((entry, position) => {
    const rampIndex = position < OVERFLOW_INDEX ? position : OVERFLOW_INDEX;
    ramp.set(entry.id, SHIFT_RAMP[rampIndex]);
  });
  return ramp;
}

/**
 * A type-aware identity key matching F3's `typedIdKey`, so the ramp assignment
 * is consistent with every other id-keyed structure in the roster domain.
 */
function typedKey(id: unknown): string {
  return typeof id === "number" ? `n:${id}` : `s:${String(id)}`;
}
