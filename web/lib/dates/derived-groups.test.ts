import { describe, expect, it } from "vitest";
import { generateDateItems } from "./date-id";
import {
  deriveDateGroups,
  isDateLiteralGroupId,
  isDerivedDateGroupId,
  isReservedDateGroupId,
} from "./derived-groups";

// A week Wed 2026-07-01 … Tue 2026-07-07 (Sat 4th + Sun 5th are the weekend).
const items = generateDateItems({ start: "2026-07-01", end: "2026-07-07" });

describe("read-only auto-derived date groups (FR-DC-35/36 / acceptance row 4)", () => {
  it("always produces ALL, WEEKDAY, WEEKEND and the seven single-weekday groups", () => {
    const ids = deriveDateGroups(items).map((g) => g.id);
    expect(ids).toEqual([
      "ALL",
      "WEEKDAY",
      "WEEKEND",
      "SUNDAY",
      "MONDAY",
      "TUESDAY",
      "WEDNESDAY",
      "THURSDAY",
      "FRIDAY",
      "SATURDAY",
    ]);
  });

  it("ALL contains every item; WEEKDAY is Mon–Fri; WEEKEND is Sat/Sun (UTC)", () => {
    const groups = Object.fromEntries(deriveDateGroups(items).map((g) => [g.id, g.members]));
    expect(groups.ALL).toEqual(["01", "02", "03", "04", "05", "06", "07"]);
    expect(groups.WEEKDAY).toEqual(["01", "02", "03", "06", "07"]);
    expect(groups.WEEKEND).toEqual(["04", "05"]);
    expect(groups.SATURDAY).toEqual(["04"]);
    expect(groups.SUNDAY).toEqual(["05"]);
  });

  it("without a range, every group (incl. WEEKDAY/WEEKEND) is empty (FR-DC-36)", () => {
    for (const group of deriveDateGroups([])) {
      expect(group.members).toEqual([]);
    }
  });

  it("recognizes reserved derived ids case-insensitively", () => {
    expect(isDerivedDateGroupId("ALL")).toBe(true);
    expect(isDerivedDateGroupId("weekday")).toBe(true);
    expect(isDerivedDateGroupId("Monday")).toBe(true);
    expect(isDerivedDateGroupId("WORKDAY")).toBe(false); // editable, not derived
    expect(isDerivedDateGroupId("PH")).toBe(false);
  });

  it("rejects concrete date-literal shapes (D / MM-DD / YYYY-MM-DD) — producer + T07 parity", () => {
    // These MUST match producer.ts:419-435 and cascade/domain.ts DATE_LITERAL_PATTERNS.
    for (const id of ["1", "15", "99", "32", "07-32", "12-31", "2020-01-01", "2026-07-01"]) {
      expect(isDateLiteralGroupId(id)).toBe(true);
    }
    // Ordinary custom names are not date literals.
    for (const id of ["Weekends", "PH", "WORKDAY", "Custom", "12-3", "20200101"]) {
      expect(isDateLiteralGroupId(id)).toBe(false);
    }
  });

  it("isReservedDateGroupId unions derived keywords and date literals", () => {
    expect(isReservedDateGroupId("weekend")).toBe(true); // derived keyword
    expect(isReservedDateGroupId("2020-01-01")).toBe(true); // date literal
    expect(isReservedDateGroupId("Weekends")).toBe(false); // ordinary custom name
    expect(isReservedDateGroupId("WORKDAY")).toBe(false); // editable, not reserved
  });
});
