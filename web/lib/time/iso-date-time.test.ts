import { describe, expect, it } from "vitest";
import { compareIsoDateTimes, isIsoDateTime, parseIsoDateTime } from "./iso-date-time";

describe("ISO date-time", () => {
  it("validates the backend proleptic and timezone boundaries", () => {
    for (const value of [
      "0001-01-01T00:00:00Z",
      "9999-12-31T23:59:59.999999999+14:00",
      "2026-07-20T00:00:00-14:00",
    ]) {
      expect(isIsoDateTime(value)).toBe(true);
    }
    for (const value of [
      "0000-01-01T00:00:00Z",
      "2026-02-29T00:00:00Z",
      "2026-07-20T00:00:00+14:01",
      "2026-07-20T00:00:00+23:59",
      "2026-07-20T00:00:00",
    ]) {
      expect(isIsoDateTime(value)).toBe(false);
    }
  });

  it("compares all fractional digits instead of truncating to milliseconds", () => {
    const earlier = "2026-07-20T00:00:00.000000001Z";
    const later = "2026-07-20T00:00:00.000000002Z";
    expect(Date.parse(earlier)).toBe(Date.parse(later));
    expect(compareIsoDateTimes(earlier, later)).toBe(-1);
    expect(compareIsoDateTimes(later, earlier)).toBe(1);
  });

  it("normalizes timezone offsets when comparing instants", () => {
    expect(compareIsoDateTimes("2026-07-20T14:00:00+14:00", "2026-07-20T00:00:00Z")).toBe(0);
    expect(parseIsoDateTime("invalid")).toBeNull();
    expect(compareIsoDateTimes("invalid", "2026-07-20T00:00:00Z")).toBeNull();
  });
});
