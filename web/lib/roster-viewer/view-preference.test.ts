// Local-calendar "today" and the restored lens/day preference (F4).

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  localCalendarDate,
  parseLens,
  readViewPreference,
  resolveFocusedDay,
  todayIndex,
  writeViewPreference,
  ROSTER_VIEW_PREFERENCE_KEY,
} from "./view-preference";

/** An in-memory Storage, so these tests never depend on a DOM being present. */
function memoryStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  } as Storage;
}

const CALENDAR = [
  { iso: "2026-07-02" },
  { iso: "2026-07-03" },
  { iso: "2026-07-04" },
  { iso: "2026-07-05" },
];

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Local calendar date
// ---------------------------------------------------------------------------

describe("localCalendarDate", () => {
  it("reads the LOCAL date parts, not the UTC instant", () => {
    // A Date whose local calendar day and UTC calendar day differ is the whole
    // point; construct one from local parts so the assertion is timezone-neutral.
    const localMidnightish = new Date(2026, 6, 4, 0, 30, 0); // 2026-07-04 00:30 local
    expect(localCalendarDate(localMidnightish)).toBe("2026-07-04");
  });

  it("zero-pads month and day", () => {
    expect(localCalendarDate(new Date(2026, 0, 5, 12, 0, 0))).toBe("2026-01-05");
  });

  // THE DEFECT THIS REPLACES, stated as a differential rather than a fixed
  // string so it holds in every runner timezone. `toISOString().slice(0,10)` is
  // the UTC date; whenever the two disagree, the LOCAL one is the user's today.
  it("disagrees with toISOString() exactly when the zone shifts the date", () => {
    // 23:30 local on the 4th. East of UTC this is still the 4th in UTC; west of
    // UTC it has already rolled to the 5th. Either way the user's today is the 4th.
    const lateLocal = new Date(2026, 6, 4, 23, 30, 0);
    expect(localCalendarDate(lateLocal)).toBe("2026-07-04");

    // And the early-morning mirror: 00:30 local on the 4th.
    const earlyLocal = new Date(2026, 6, 4, 0, 30, 0);
    expect(localCalendarDate(earlyLocal)).toBe("2026-07-04");

    // At least one of the two boundary instants disagrees with the UTC date in
    // any non-UTC zone — which is precisely the window the old code got wrong.
    const utcOffsetMinutes = earlyLocal.getTimezoneOffset();
    if (utcOffsetMinutes !== 0) {
      const drifting = utcOffsetMinutes > 0 ? lateLocal : earlyLocal;
      expect(drifting.toISOString().slice(0, 10)).not.toBe(localCalendarDate(drifting));
    }
  });
});

describe("todayIndex", () => {
  it("selects today when the roster covers it", () => {
    expect(todayIndex(CALENDAR, new Date(2026, 6, 4, 9, 0, 0))).toBe(2);
  });

  it("falls back to the first day when today is outside the span", () => {
    expect(todayIndex(CALENDAR, new Date(2026, 7, 20, 9, 0, 0))).toBe(0);
  });

  it("is 0 for an empty calendar", () => {
    expect(todayIndex([], new Date(2026, 6, 4))).toBe(0);
  });

  // The Singapore case named in the review, as a genuine differential rather
  // than a mocked offset: `getTimezoneOffset` cannot change what `getFullYear()`
  // returns, so faking it would prove nothing. Instead take the exact instant
  // 2026-07-03T16:30Z and compare the two derivations directly under a fixed
  // UTC+8 zone — the old code picked the 3rd, the new one picks the 4th.
  it("selects the user's local day, not the UTC day, at a zone boundary", () => {
    const instant = new Date("2026-07-03T16:30:00.000Z");
    const inSingapore = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Singapore",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(instant);

    // The premise: this instant IS a different calendar day in SGT than in UTC.
    expect(inSingapore).toBe("2026-07-04");
    expect(instant.toISOString().slice(0, 10)).toBe("2026-07-03");

    // A local clock reading 2026-07-04 00:30 — what a nurse in SGT actually sees.
    const localReading = new Date(2026, 6, 4, 0, 30, 0);
    expect(localCalendarDate(localReading)).toBe(inSingapore);
    expect(todayIndex(CALENDAR, localReading)).toBe(2);
    // The old derivation would have landed on the 3rd — index 1, not 2.
    expect(CALENDAR.findIndex((d) => d.iso === instant.toISOString().slice(0, 10))).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Persistence and range-checking
// ---------------------------------------------------------------------------

describe("parseLens", () => {
  it("accepts the three real lenses and rejects anything else", () => {
    expect(parseLens("grid")).toBe("grid");
    expect(parseLens("coverage")).toBe("coverage");
    expect(parseLens("day")).toBe("day");
    expect(parseLens("timeline")).toBeNull();
    expect(parseLens(3)).toBeNull();
    expect(parseLens(null)).toBeNull();
  });
});

describe("readViewPreference", () => {
  it("round-trips a written preference", () => {
    const store = memoryStorage();
    writeViewPreference({ lens: "coverage", focusedIso: "2026-07-04" }, store);
    expect(readViewPreference(store)).toEqual({ lens: "coverage", focusedIso: "2026-07-04" });
  });

  it("returns null for absent, unparseable, or structurally wrong entries", () => {
    expect(readViewPreference(memoryStorage())).toBeNull();
    expect(readViewPreference(memoryStorage({ [ROSTER_VIEW_PREFERENCE_KEY]: "{{" }))).toBeNull();
    expect(readViewPreference(memoryStorage({ [ROSTER_VIEW_PREFERENCE_KEY]: "[]" }))).toBeNull();
    // A lens this build does not render is not half-trusted.
    expect(
      readViewPreference(
        memoryStorage({ [ROSTER_VIEW_PREFERENCE_KEY]: JSON.stringify({ lens: "timeline" }) }),
      ),
    ).toBeNull();
  });

  it("drops a malformed focused date but keeps a valid lens", () => {
    const store = memoryStorage({
      [ROSTER_VIEW_PREFERENCE_KEY]: JSON.stringify({ lens: "day", focusedIso: "not-a-date" }),
    });
    expect(readViewPreference(store)).toEqual({ lens: "day", focusedIso: null });
  });

  it("survives a storage that throws on access", () => {
    const hostile = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
    } as unknown as Storage;
    expect(readViewPreference(hostile)).toBeNull();
    expect(() => writeViewPreference({ lens: "grid", focusedIso: null }, hostile)).not.toThrow();
  });
});

describe("resolveFocusedDay", () => {
  it("restores a persisted day that exists in this roster", () => {
    expect(resolveFocusedDay(CALENDAR, { lens: "day", focusedIso: "2026-07-05" })).toBe(3);
  });

  // THE RANGE CHECK. A stored INDEX would have landed on whatever day now
  // occupies that slot — a wrong answer that looks like a right one. An ISO date
  // either exists in this calendar or it does not.
  it("falls back to today when the persisted day is not in this roster", () => {
    const shorter = [{ iso: "2026-07-02" }, { iso: "2026-07-03" }];
    expect(
      resolveFocusedDay(
        shorter,
        { lens: "day", focusedIso: "2026-07-05" },
        new Date(2026, 6, 3, 9, 0, 0),
      ),
    ).toBe(1);
  });

  it("falls back to the first day when neither the persisted day nor today fit", () => {
    expect(
      resolveFocusedDay(
        CALENDAR,
        { lens: "day", focusedIso: "2020-01-01" },
        new Date(2026, 7, 20, 9, 0, 0),
      ),
    ).toBe(0);
  });

  it("uses today when there is no persisted preference at all", () => {
    expect(resolveFocusedDay(CALENDAR, null, new Date(2026, 6, 4, 9, 0, 0))).toBe(2);
  });
});
