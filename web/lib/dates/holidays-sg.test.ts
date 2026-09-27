import { describe, expect, it } from "vitest";
import {
  getHolidaysInRange,
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
    expect(getSupportLabel()).toBe("2024-01-01 to 2027-12-31");
  });

  it("supports the days after the last holiday of the final year", () => {
    // Last listed entry is 2027-12-25; the rest of December is known non-holiday.
    expect(isRangeSupported({ start: "2027-12-01", end: "2027-12-31" })).toBe(true);
  });

  it("range support uses lexicographic ISO comparison and requires both endpoints", () => {
    expect(isRangeSupported({ start: "2026-07-01", end: "2026-07-31" })).toBe(true);
    expect(isRangeSupported({ start: "2023-01-01", end: "2026-07-31" })).toBe(false); // before window
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
