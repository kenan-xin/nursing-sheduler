/**
 * The roster grid's shift colour system (DESIGN.md §2 "Shift colour
 * palette"). Every worked shift is assigned to one of four families —
 * Morning, Evening, Night, Long day — by its own `startTime` and duration,
 * never by parsing its id. Ward-authored naming conventions (`am1+`, `A18`,
 * `D+`, ...) vary per ward and are never inspected.
 */

/**
 * One ramp colour. `fill`+`ink` are the chip; `bar` is the legend dot and the
 * Day-view tag colour.
 */
export interface ShiftRampEntry {
  fill: string;
  ink: string;
  bar: string;
}

export type ShiftFamily = "morning" | "evening" | "long" | "night" | "other";

/**
 * The five ramp entries. Index 0-3 are the literal DESIGN.md hexes, unchanged
 * from the retired 8-entry ramp; index 4 is the fallback for a shift whose
 * time cannot be classified.
 */
export const SHIFT_RAMP: readonly ShiftRampEntry[] = [
  { fill: "#f8e2b8", ink: "#7a5310", bar: "#d4a038" }, // 0 morning — amber
  { fill: "#f6dbcd", ink: "#9a4726", bar: "#cf7049" }, // 1 evening — clay
  { fill: "#e4ecd0", ink: "#586a22", bar: "#8fa243" }, // 2 long day — olive
  { fill: "#d8e0f2", ink: "#374777", bar: "#6274ad" }, // 3 night — cool slate
  { fill: "#2b2733", ink: "#ece6f2", bar: "#5c5468" }, // 4 other (unparseable time)
] as const;

export const SHIFT_FAMILY_RAMP: Record<ShiftFamily, ShiftRampEntry> = {
  morning: SHIFT_RAMP[0],
  evening: SHIFT_RAMP[1],
  long: SHIFT_RAMP[2],
  night: SHIFT_RAMP[3],
  other: SHIFT_RAMP[4],
};

export const SHIFT_FAMILY_LABEL: Record<ShiftFamily, string> = {
  morning: "Morning",
  evening: "Evening",
  night: "Night",
  long: "Long day",
  other: "Other",
};

export const SHIFT_FAMILY_GLYPH: Record<ShiftFamily, string> = {
  morning: "AM",
  evening: "PM",
  // "N" can coincidentally match a ward-authored shift literally named "N"
  // (the default fixture does exactly this). The two are unrelated after this
  // change: this is the FAMILY glyph, keyed off the classifier, never off the
  // authored id string.
  night: "N",
  long: "LD",
  other: "?",
};

/** Legend display order — the order a ward's day actually runs. */
export const SHIFT_FAMILY_ORDER: readonly ShiftFamily[] = [
  "morning",
  "evening",
  "night",
  "long",
  "other",
];

/** A shift starting at or after this hour, or before `NIGHT_END_HOUR`, is Night. */
const NIGHT_START_HOUR = 18;
const NIGHT_END_HOUR = 6;

/** A shift lasting this many minutes or more (and not already Night) is Long day. */
const LONG_DURATION_MINUTES = 10 * 60;

/**
 * Classify a shift into its colour family from its own `startTime` and
 * duration. Order matters: Night is checked before Long day so a 12.5h
 * overnight shift (e.g. `night`, `LN8`, 20:00-08:30) lands in Night rather
 * than Long day.
 */
export function classifyShiftFamily(shift: {
  startTime?: string;
  endTime?: string;
  durationMinutes?: number;
}): ShiftFamily {
  const startMinutes = timeToMinutes(shift.startTime);
  if (startMinutes === null) return "other";

  const startHour = Math.floor(startMinutes / 60);
  if (startHour >= NIGHT_START_HOUR || startHour < NIGHT_END_HOUR) return "night";

  const duration = resolveDurationMinutes(shift);
  if (duration !== null && duration >= LONG_DURATION_MINUTES) return "long";

  return startHour < 12 ? "morning" : "evening";
}

/**
 * Assign each worked shift type its family's ramp entry, keyed by the same
 * type-aware id key every other id-keyed roster structure uses (F3's
 * `typedIdKey`), so a numeric id and a string id of the same value never
 * collide.
 */
export function assignShiftRamp<
  TShift extends { id: unknown; startTime?: string; endTime?: string; durationMinutes?: number },
>(shiftTypes: readonly TShift[]): Map<string, ShiftRampEntry> {
  const ramp = new Map<string, ShiftRampEntry>();
  for (const shift of shiftTypes) {
    ramp.set(typedKey(shift.id), SHIFT_FAMILY_RAMP[classifyShiftFamily(shift)]);
  }
  return ramp;
}

/** `"HH:MM"` → minutes since midnight, or `null` when unparseable/absent. */
function timeToMinutes(time: string | undefined): number | null {
  if (typeof time !== "string") return null;
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (match === null) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Prefer the ward's own authored `durationMinutes` (Option B, `models.py`)
 * when present — it is exactly the paid working minutes and needs no
 * day-wrap guessing. Otherwise derive it from `startTime`/`endTime`, treating
 * an end time not later than the start as crossing midnight.
 */
function resolveDurationMinutes(shift: {
  startTime?: string;
  endTime?: string;
  durationMinutes?: number;
}): number | null {
  if (typeof shift.durationMinutes === "number" && shift.durationMinutes > 0) {
    return shift.durationMinutes;
  }
  const start = timeToMinutes(shift.startTime);
  const end = timeToMinutes(shift.endTime);
  if (start === null || end === null) return null;
  return end > start ? end - start : end + 24 * 60 - start;
}

/**
 * A type-aware identity key matching F3's `typedIdKey`, so the ramp assignment
 * is consistent with every other id-keyed structure in the roster domain.
 */
function typedKey(id: unknown): string {
  return typeof id === "number" ? `n:${id}` : `s:${String(id)}`;
}
