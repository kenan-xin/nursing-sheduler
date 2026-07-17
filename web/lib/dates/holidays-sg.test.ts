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
  it("derives the window from the dataset min/max", () => {
    const supported = getSupportedRange();
    expect(supported).toEqual({
      start: SINGAPORE_HOLIDAYS[0].date,
      end: SINGAPORE_HOLIDAYS[SINGAPORE_HOLIDAYS.length - 1].date,
    });
    expect(getSupportLabel()).toBe(`${supported!.start} to ${supported!.end}`);
  });

  it("range support uses lexicographic ISO comparison and requires both endpoints", () => {
    expect(isRangeSupported({ start: "2026-07-01", end: "2026-07-31" })).toBe(true);
    expect(isRangeSupported({ start: "2023-01-01", end: "2026-07-31" })).toBe(false); // before window
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
