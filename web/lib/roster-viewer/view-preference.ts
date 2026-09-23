// Roster view preference (F4) — local "today" and the restored lens/day.
//
// Two small things live here because both are easy to get subtly wrong and both
// are pure enough to test directly.
//
// 1. TODAY IS A LOCAL CALENDAR DATE, not a UTC instant. `toISOString().slice(0,10)`
//    is the UTC date, which is a different day from the user's for a large part
//    of every 24 hours in any non-UTC zone. In Singapore (UTC+8), any local time
//    before 08:00 resolves to the PREVIOUS UTC date — so a nurse opening the
//    roster at 07:00 on the 4th would have the 3rd selected. The roster's
//    calendar is a list of local calendar dates, so the comparison must be too.
//
// 2. THE RESTORED VALUE IS RANGE-CHECKED. A persisted day index is only
//    meaningful against the roster that was on screen when it was written; a
//    later roster may be shorter, and a stored lens may be a name this build no
//    longer has. Anything that does not validate is discarded in favour of the
//    normal default rather than trusted.

/** The three roster lenses. Duplicated here so this module stays React-free. */
export type RosterLensName = "grid" | "coverage" | "day";

const LENS_NAMES: readonly RosterLensName[] = ["grid", "coverage", "day"];

/** Where the last-used lens and focused date are kept across a reload. */
export const ROSTER_VIEW_PREFERENCE_KEY = "nursing-scheduler.roster-view";

export interface RosterViewPreference {
  lens: RosterLensName;
  /** The focused day as an ISO date, NOT an index — see `resolveFocusedDay`. */
  focusedIso: string | null;
}

/**
 * The browser's LOCAL calendar date as `YYYY-MM-DD`.
 *
 * Built from the local date parts rather than by formatting an instant, so it
 * names the day the user is actually living in.
 */
export function localCalendarDate(now: Date = new Date()): string {
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * The day index to open on: today when the roster covers it, else the first day.
 */
export function todayIndex(calendar: readonly { iso: string }[], now?: Date): number {
  if (calendar.length === 0) return 0;
  const today = localCalendarDate(now);
  const index = calendar.findIndex((day) => day.iso === today);
  return index >= 0 ? index : 0;
}

/** Narrow an unknown value to a lens name this build actually renders. */
export function parseLens(value: unknown): RosterLensName | null {
  return typeof value === "string" && (LENS_NAMES as readonly string[]).includes(value)
    ? (value as RosterLensName)
    : null;
}

/**
 * Resolve a persisted preference against the roster now on screen.
 *
 * The focused day is persisted as an ISO DATE rather than an index precisely so
 * that restoring it against a different roster is a meaningful question: an
 * index would silently land on whatever day now occupies that slot, which is a
 * wrong answer wearing a right answer's clothes. An ISO date either exists in
 * this calendar or it does not.
 */
export function resolveFocusedDay(
  calendar: readonly { iso: string }[],
  preference: RosterViewPreference | null,
  now?: Date,
): number {
  if (preference?.focusedIso != null) {
    const index = calendar.findIndex((day) => day.iso === preference.focusedIso);
    if (index >= 0) return index;
  }
  return todayIndex(calendar, now);
}

/**
 * Read the stored preference. Returns null for absent, unparseable, or
 * structurally wrong data — a corrupt entry must not be able to throw during
 * render, and a partially-valid one must not be half-trusted.
 */
export function readViewPreference(storage?: Storage | null): RosterViewPreference | null {
  const store = storage ?? safeLocalStorage();
  if (store === null) return null;
  let raw: string | null;
  try {
    raw = store.getItem(ROSTER_VIEW_PREFERENCE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const lens = parseLens(record.lens);
  if (lens === null) return null;
  const focusedIso = record.focusedIso;
  return {
    lens,
    focusedIso: typeof focusedIso === "string" && ISO_DATE.test(focusedIso) ? focusedIso : null,
  };
}

/** Persist the preference. Storage failures are non-fatal: this is a nicety. */
export function writeViewPreference(
  preference: RosterViewPreference,
  storage?: Storage | null,
): void {
  const store = storage ?? safeLocalStorage();
  if (store === null) return;
  try {
    store.setItem(ROSTER_VIEW_PREFERENCE_KEY, JSON.stringify(preference));
  } catch {
    // A denied or full storage must never break the viewer.
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function safeLocalStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Storage access throws outright in some hardened/partitioned contexts.
    return null;
  }
}
