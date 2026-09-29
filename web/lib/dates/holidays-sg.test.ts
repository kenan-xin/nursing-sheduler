import { afterEach, describe, expect, it } from "vitest";
import {
  getHolidaysInRange,
  getSingaporeHolidays,
  holidayCoverageWarning,
  mergeSingaporeHolidays,
  missingHolidayYears,
  parseHolidayName,
  setSingaporeHolidays,
  subscribeSingaporeHolidays,
  getSupportedRange,
  getSupportLabel,
  isRangeSupported,
  isSingaporeNonWorkDay,
  isSingaporePublicHoliday,
  SINGAPORE_HOLIDAYS,
  type SingaporeHolidayEntry,
} from "./holidays-sg";

describe("SG holiday dataset — English only (FR-DC-23/24 / acceptance row 2)", () => {
  it("every entry has exactly {date, name, isObserved} — no bilingual/second-language column", () => {
    for (const entry of SINGAPORE_HOLIDAYS) {
      expect(Object.keys(entry).sort()).toEqual(["date", "isObserved", "name"]);
      expect(typeof entry.name).toBe("string");
      expect(entry.name.length).toBeGreaterThan(0);
    }
  });

  it("names never contain the literal (Observed) suffix — it is parsed into isObserved", () => {
    for (const entry of SINGAPORE_HOLIDAYS) {
      expect(entry.name).not.toContain("(Observed)");
    }
  });

  it("parsed observed substitute days carry isObserved: true with the clean name", () => {
    const vesakObserved = SINGAPORE_HOLIDAYS.find((e) => e.date === "2026-06-01");
    expect(vesakObserved).toEqual<SingaporeHolidayEntry>({
      date: "2026-06-01",
      name: "Vesak Day",
      isObserved: true,
    });
  });

  it("names contain no CJK / non-Latin characters (English-only)", () => {
    const nonLatin = /[　-鿿가-힯]/u;
    for (const entry of SINGAPORE_HOLIDAYS) {
      expect(nonLatin.test(entry.name)).toBe(false);
    }
  });

  it("entries are chronologically ordered", () => {
    const dates = SINGAPORE_HOLIDAYS.map((e) => e.date);
    expect([...dates].sort()).toEqual(dates);
  });
});

describe("classification", () => {
  it("marks gazetted holidays (actual + observed) as public holidays", () => {
    expect(isSingaporePublicHoliday("2026-08-09")).toBe(true); // National Day
    expect(isSingaporePublicHoliday("2026-08-10")).toBe(true); // observed substitute
    expect(isSingaporePublicHoliday("2026-07-15")).toBe(false); // ordinary Wednesday
  });

  it("NON-WORKDAY = holiday OR weekend", () => {
    expect(isSingaporeNonWorkDay("2026-05-01")).toBe(true); // Labour Day (Fri holiday)
    expect(isSingaporeNonWorkDay("2026-07-04")).toBe(true); // plain Saturday
    expect(isSingaporeNonWorkDay("2026-07-05")).toBe(true); // plain Sunday
    expect(isSingaporeNonWorkDay("2026-07-15")).toBe(false); // plain Wednesday
  });
});

describe("supported window (FR-DC-29/30/31)", () => {
  it("derives the window as whole calendar years of the dataset min/max", () => {
    // data.gov.sg publishes whole years, so the window spans 1 January of the
    // first listed year to 31 December of the last — not the first/last holiday.
    const firstYear = SINGAPORE_HOLIDAYS[0].date.slice(0, 4);
    const lastYear = SINGAPORE_HOLIDAYS[SINGAPORE_HOLIDAYS.length - 1].date.slice(0, 4);
    const supported = getSupportedRange();
    expect(supported).toEqual({
      start: `${firstYear}-01-01`,
      end: `${lastYear}-12-31`,
    });
    expect(getSupportLabel()).toBe(`${supported!.start} to ${supported!.end}`);
    expect(getSupportLabel()).toBe("2020-01-01 to 2027-12-31");
  });

  it("supports the days after the last holiday of the final year", () => {
    // Last listed entry is 2027-12-25; the rest of December is known non-holiday.
    expect(isRangeSupported({ start: "2027-12-01", end: "2027-12-31" })).toBe(true);
  });

  it("range support uses lexicographic ISO comparison and requires both endpoints", () => {
    expect(isRangeSupported({ start: "2026-07-01", end: "2026-07-31" })).toBe(true);
    expect(isRangeSupported({ start: "2019-01-01", end: "2026-07-31" })).toBe(false); // before window
    expect(isRangeSupported({ start: "2026-07-01", end: "2028-01-01" })).toBe(false); // after window
    expect(isRangeSupported({ start: "2026-07-01", end: "" })).toBe(false);
  });

  it("returns only entries inside the range", () => {
    const inRange = getHolidaysInRange({ start: "2026-05-01", end: "2026-06-30" });
    expect(inRange.map((e) => e.date)).toEqual([
      "2026-05-01",
      "2026-05-27",
      "2026-05-31",
      "2026-06-01",
    ]);
    expect(getHolidaysInRange({ start: "2026-07-06", end: "2026-07-10" })).toEqual([]);
  });
});

describe("active list, merge and coverage (bead si4j)", () => {
  afterEach(() => setSingaporeHolidays(SINGAPORE_HOLIDAYS));

  const row = (date: string, name: string): SingaporeHolidayEntry => ({
    date,
    name,
    isObserved: false,
  });

  it("parses the upstream (Observed) suffix into isObserved, name verbatim", () => {
    expect(parseHolidayName("Vesak Day (Observed)")).toEqual({
      name: "Vesak Day",
      isObserved: true,
    });
    expect(parseHolidayName("New Year’s Day")).toEqual({
      name: "New Year’s Day",
      isObserved: false,
    });
  });

  it("merges by year: live years win whole, bundled rows fill only missing years", () => {
    const live = [row("2027-03-11", "Hari Raya Puasa"), row("2028-01-01", "New Year's Day")];
    const bundled = [row("2026-01-01", "New Year's Day"), row("2027-03-10", "Hari Raya Puasa")];
    // 2027's moved holiday does not survive as a stale bundled date.
    expect(mergeSingaporeHolidays(live, bundled).map((e) => e.date)).toEqual([
      "2026-01-01",
      "2027-03-11",
      "2028-01-01",
    ]);
  });

  it("the helpers read the installed list and notify subscribers", () => {
    let calls = 0;
    const unsubscribe = subscribeSingaporeHolidays(() => calls++);
    const extended = mergeSingaporeHolidays(
      [row("2028-08-09", "National Day")],
      SINGAPORE_HOLIDAYS,
    );
    setSingaporeHolidays(extended);
    expect(calls).toBe(1);
    expect(getSingaporeHolidays()).toBe(extended);
    expect(isSingaporePublicHoliday("2028-08-09")).toBe(true);
    expect(isRangeSupported({ start: "2027-12-01", end: "2028-01-31" })).toBe(true);
    expect(getSupportedRange()?.end).toBe("2028-12-31");
    unsubscribe();
  });

  it("reports the uncovered years and the shared warning", () => {
    expect(missingHolidayYears({ start: "2027-12-01", end: "2028-01-31" })).toEqual(["2028"]);
    expect(holidayCoverageWarning({ start: "2027-12-01", end: "2028-01-31" })).toBe(
      "No public-holiday data for 2028 yet. Holidays in those dates are not marked.",
    );
    expect(holidayCoverageWarning({ start: "2028-01-01", end: "2029-01-01" })).toContain(
      "for 2028 and 2029 yet",
    );
    expect(holidayCoverageWarning({ start: "2028-01-01", end: "2030-01-01" })).toContain(
      "for 2028–2030 yet",
    );
    expect(holidayCoverageWarning({ start: "2026-01-01", end: "2027-12-31" })).toBeNull();
  });

  it("a gap year inside the window is not supported", () => {
    setSingaporeHolidays([row("2026-01-01", "a"), row("2028-01-01", "b")]);
    expect(isRangeSupported({ start: "2026-06-01", end: "2028-06-01" })).toBe(false);
    expect(missingHolidayYears({ start: "2026-06-01", end: "2028-06-01" })).toEqual(["2027"]);
  });
});

describe("bundled snapshot staleness guard (bead si4j)", () => {
  // Six months, not twelve: MOM publishes next year's holidays around mid-year, so a
  // 12-month guard would sit red from late December with nothing to refresh. This one
  // goes red from ~1 July of the bundle's last year, once the data usually exists.
  it("the bundled list covers at least the next 6 months", () => {
    const lastYear = SINGAPORE_HOLIDAYS[SINGAPORE_HOLIDAYS.length - 1].date.slice(0, 4);
    const coveredUntil = `${lastYear}-12-31`;
    const horizon = new Date();
    horizon.setUTCMonth(horizon.getUTCMonth() + 6);
    const horizonIso = horizon.toISOString().slice(0, 10);
    expect(
      coveredUntil >= horizonIso,
      `The bundled Singapore holidays end ${coveredUntil}, less than 6 months from today. ` +
        "Refresh the offline fallback: `cd web && pnpm refresh:sg-holidays`, then commit " +
        "lib/dates/holidays-sg.ts (MOM usually publishes the next year's holidays mid-year).",
    ).toBe(true);
  });
});
