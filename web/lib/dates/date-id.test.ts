import { describe, expect, it } from "vitest";
import {
  dateIdToIso,
  describeDate,
  generateDateIds,
  generateDateItems,
  getDateIdForRange,
  hasCompleteRange,
  isValidIso,
  rangeDayCount,
  spannedMonths,
  utcDayOfWeek,
} from "./date-id";

describe("isValidIso", () => {
  it("accepts real ISO dates and rejects malformed or overflow dates", () => {
    expect(isValidIso("2026-07-01")).toBe(true);
    expect(isValidIso("2026-02-28")).toBe(true);
    expect(isValidIso("2026-2-1")).toBe(false); // not zero-padded
    expect(isValidIso("2026-13-01")).toBe(false); // bad month
    expect(isValidIso("2026-02-31")).toBe(false); // overflow rolls to March → rejected
    expect(isValidIso("")).toBe(false);
  });
});

describe("ID format by span (FR-DC-11 / acceptance row 1)", () => {
  it("uses DD within a single month", () => {
    const range = { start: "2026-07-01", end: "2026-07-31" };
    expect(generateDateIds(range).slice(0, 3)).toEqual(["01", "02", "03"]);
    expect(getDateIdForRange("2026-07-15", range)).toBe("15");
  });

  it("uses MM-DD within a single year spanning months", () => {
    const range = { start: "2026-07-01", end: "2026-08-15" };
    const ids = generateDateIds(range);
    expect(ids[0]).toBe("07-01");
    expect(ids.at(-1)).toBe("08-15");
    expect(getDateIdForRange("2026-08-09", range)).toBe("08-09");
  });

  it("uses full YYYY-MM-DD across a year boundary", () => {
    const range = { start: "2026-12-30", end: "2027-01-02" };
    expect(generateDateIds(range)).toEqual([
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
    ]);
  });

  it("falls back to the bare ISO string when the range is incomplete", () => {
    expect(getDateIdForRange("2026-07-01", { start: "", end: "" })).toBe("2026-07-01");
  });
});

describe("generateDateItems", () => {
  it("emits one inclusive item per day with the Weekday, Mon D, YYYY description", () => {
    const items = generateDateItems({ start: "2026-07-01", end: "2026-07-03" });
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({
      id: "01",
      iso: "2026-07-01",
      description: "Wednesday, Jul 1, 2026",
    });
    expect(items[2].description).toBe("Friday, Jul 3, 2026");
  });

  it("returns [] for an incomplete or reversed range", () => {
    expect(generateDateItems({ start: "", end: "2026-07-03" })).toEqual([]);
    expect(generateDateItems({ start: "2026-07-05", end: "2026-07-01" })).toEqual([]);
  });

  it("crosses month and year boundaries correctly", () => {
    const items = generateDateItems({ start: "2026-12-31", end: "2027-01-01" });
    expect(items.map((i) => i.iso)).toEqual(["2026-12-31", "2027-01-01"]);
  });
});

describe("dateIdToIso round-trip (FR-DC-12)", () => {
  it("resolves DD ids against the range start month/year", () => {
    const range = { start: "2026-07-01", end: "2026-07-31" };
    expect(dateIdToIso("15", range)).toBe("2026-07-15");
  });

  it("resolves MM-DD ids against the range start year", () => {
    const range = { start: "2026-07-01", end: "2026-08-31" };
    expect(dateIdToIso("08-09", range)).toBe("2026-08-09");
  });

  it("returns YYYY-MM-DD ids verbatim", () => {
    const range = { start: "2026-12-30", end: "2027-01-02" };
    expect(dateIdToIso("2027-01-01", range)).toBe("2027-01-01");
  });

  it("returns null for a partial id with no range start, or an unrecognized id", () => {
    expect(dateIdToIso("15", { start: "", end: "" })).toBeNull();
    expect(dateIdToIso("not-a-date", { start: "2026-07-01", end: "2026-07-31" })).toBeNull();
  });

  it("round-trips every generated id back to its iso", () => {
    const range = { start: "2026-07-28", end: "2026-08-03" };
    for (const item of generateDateItems(range)) {
      expect(dateIdToIso(item.id, range)).toBe(item.iso);
    }
  });
});

describe("misc helpers", () => {
  it("computes UTC day-of-week", () => {
    expect(utcDayOfWeek("2026-07-01")).toBe(3); // Wednesday
    expect(utcDayOfWeek("2026-07-04")).toBe(6); // Saturday
    expect(utcDayOfWeek("2026-07-05")).toBe(0); // Sunday
  });

  it("counts inclusive days, single-day range is 1", () => {
    expect(rangeDayCount({ start: "2026-07-01", end: "2026-07-01" })).toBe(1);
    expect(rangeDayCount({ start: "2026-07-01", end: "2026-07-31" })).toBe(31);
    expect(rangeDayCount({ start: "", end: "" })).toBe(0);
  });

  it("lists spanned months as first-of-month keys", () => {
    expect(spannedMonths({ start: "2026-07-15", end: "2026-09-02" })).toEqual([
      "2026-07-01",
      "2026-08-01",
      "2026-09-01",
    ]);
    expect(spannedMonths({ start: "2026-12-30", end: "2027-01-02" })).toEqual([
      "2026-12-01",
      "2027-01-01",
    ]);
  });

  it("describeDate formats in UTC", () => {
    expect(describeDate("2027-01-01")).toBe("Friday, Jan 1, 2027");
  });

  it("hasCompleteRange guards endpoints and order", () => {
    expect(hasCompleteRange({ start: "2026-07-01", end: "2026-07-02" })).toBe(true);
    expect(hasCompleteRange({ start: "2026-07-02", end: "2026-07-01" })).toBe(false);
    expect(hasCompleteRange({ start: "2026-07-01", end: "" })).toBe(false);
  });
});
