import { describe, expect, it } from "vitest";
import { validatePeopleHistoryCsv, validateShiftRequestCsv } from "./requests-csv";

const PEOPLE_IDS = ["alice", "bob", "carol"];
const DATE_ITEM_IDS = ["d1", "d2"];
const VALID_SHIFT_TYPE_IDS = ["DAY", "NIGHT", "ALL_SHIFTS"]; // items + a group
const VALID_SHIFT_TYPE_ITEM_IDS = ["DAY", "NIGHT"]; // items only

function shiftRequestOptions(
  overrides: Partial<Parameters<typeof validateShiftRequestCsv>[1]> = {},
) {
  return {
    peopleIds: PEOPLE_IDS,
    dateItemIds: DATE_ITEM_IDS,
    validShiftTypeIds: VALID_SHIFT_TYPE_IDS,
    weight: 5,
    ...overrides,
  };
}

describe("validateShiftRequestCsv", () => {
  it("parses a valid matrix into additive per-cell deltas", () => {
    const csv = ["alice,DAY,", "bob,,NIGHT", "carol,ALL_SHIFTS,DAY"].join("\n");
    const result = validateShiftRequestCsv(csv, shiftRequestOptions());
    expect(result).toEqual({
      ok: true,
      data: [
        { personId: "alice", dateId: "d1", shiftType: "DAY" },
        { personId: "bob", dateId: "d2", shiftType: "NIGHT" },
        { personId: "carol", dateId: "d1", shiftType: "ALL_SHIFTS" },
        { personId: "carol", dateId: "d2", shiftType: "DAY" },
      ],
    });
  });

  it("rejects an invalid add-form weight before checking row shape", () => {
    const result = validateShiftRequestCsv("garbage", shiftRequestOptions({ weight: "abc" }));
    expect(result).toEqual({
      ok: false,
      error: "Weight must be a valid number, Infinity, or -Infinity.",
    });
  });

  it("rejects empty file content", () => {
    const result = validateShiftRequestCsv("", shiftRequestOptions());
    expect(result).toEqual({ ok: false, error: "No content found in the uploaded file." });
  });

  it("rejects the wrong number of rows", () => {
    const csv = ["alice,DAY,", "bob,,NIGHT"].join("\n");
    const result = validateShiftRequestCsv(csv, shiftRequestOptions());
    expect(result).toEqual({
      ok: false,
      error: "CSV should have 3 rows (1 header + 3 people), but has 2 rows.",
    });
  });

  it("rejects a row with the wrong column count", () => {
    const csv = ["alice,DAY", "bob,,NIGHT", "carol,,"].join("\n");
    const result = validateShiftRequestCsv(csv, shiftRequestOptions());
    expect(result).toEqual({
      ok: false,
      error: "Row 1 should have 3 columns (dates), but has 2 columns.",
    });
  });

  it("rejects an unknown person ID", () => {
    const csv = ["dave,,", "bob,,", "carol,,"].join("\n");
    const result = validateShiftRequestCsv(csv, shiftRequestOptions());
    expect(result).toEqual({
      ok: false,
      error: 'Row 1 has invalid person ID "dave". Valid person IDs: alice, bob, carol',
    });
  });

  it("rejects a duplicate person ID", () => {
    const csv = ["alice,,", "alice,,", "carol,,"].join("\n");
    const result = validateShiftRequestCsv(csv, shiftRequestOptions());
    expect(result).toEqual({
      ok: false,
      error: 'Duplicate person ID "alice" found at row 2. Person was already seen at row 1.',
    });
  });

  it("rejects an unknown shift type in a cell", () => {
    const csv = ["alice,BOGUS,", "bob,,", "carol,,"].join("\n");
    const result = validateShiftRequestCsv(csv, shiftRequestOptions());
    expect(result).toEqual({
      ok: false,
      error:
        'Invalid shift type "BOGUS" at row 1, column 2. Valid shift types: DAY, NIGHT, ALL_SHIFTS',
    });
  });

  it("wraps a thrown parse error in the verbatim catch message", () => {
    const throwingText = {
      split: () => {
        throw new Error("boom");
      },
    } as unknown as string;
    const result = validateShiftRequestCsv(throwingText, shiftRequestOptions());
    expect(result).toEqual({
      ok: false,
      error: "Error processing shift-requests CSV file. Please check the file format.",
    });
  });
});

describe("validatePeopleHistoryCsv", () => {
  function options(overrides: Partial<Parameters<typeof validatePeopleHistoryCsv>[1]> = {}) {
    return {
      peopleIds: PEOPLE_IDS,
      validShiftTypeItemIds: VALID_SHIFT_TYPE_ITEM_IDS,
      ...overrides,
    };
  }

  it("parses valid rows, including an empty shift type that clears history", () => {
    const csv = ["alice,DAY,3", "bob,,0", "carol,NIGHT,10"].join("\n");
    const result = validatePeopleHistoryCsv(csv, options());
    expect(result).toEqual({
      ok: true,
      data: [
        { personId: "alice", shiftType: "DAY", repetitionCount: 3 },
        { personId: "bob", shiftType: "", repetitionCount: 0 },
        { personId: "carol", shiftType: "NIGHT", repetitionCount: 10 },
      ],
    });
  });

  it("truncates a decimal repetition count via parseInt (2.5 -> 2)", () => {
    const csv = ["alice,DAY,2.5", "bob,,0", "carol,,0"].join("\n");
    const result = validatePeopleHistoryCsv(csv, options());
    expect(result).toEqual({
      ok: true,
      data: [
        { personId: "alice", shiftType: "DAY", repetitionCount: 2 },
        { personId: "bob", shiftType: "", repetitionCount: 0 },
        { personId: "carol", shiftType: "", repetitionCount: 0 },
      ],
    });
  });

  it("truncates a partially-numeric repetition count via parseInt (2abc -> 2)", () => {
    const csv = ["alice,DAY,2abc", "bob,,0", "carol,,0"].join("\n");
    const result = validatePeopleHistoryCsv(csv, options());
    expect(result.ok).toBe(true);
    expect(result.ok && result.data[0]).toEqual({
      personId: "alice",
      shiftType: "DAY",
      repetitionCount: 2,
    });
  });

  it("rejects empty file content", () => {
    const result = validatePeopleHistoryCsv("", options());
    expect(result).toEqual({ ok: false, error: "No content found in the uploaded file." });
  });

  it("rejects the wrong number of rows", () => {
    const csv = ["alice,DAY,3", "bob,,0"].join("\n");
    const result = validatePeopleHistoryCsv(csv, options());
    expect(result).toEqual({
      ok: false,
      error: "CSV should have 3 rows (one per person), but has 2 rows.",
    });
  });

  it("rejects a row with the wrong column count", () => {
    const csv = ["alice,DAY", "bob,,0", "carol,,0"].join("\n");
    const result = validatePeopleHistoryCsv(csv, options());
    expect(result).toEqual({
      ok: false,
      error: "Row 1 should have 3 columns (name, shift type, repetition count), but has 2 columns.",
    });
  });

  it("rejects an unknown person ID", () => {
    const csv = ["dave,,0", "bob,,0", "carol,,0"].join("\n");
    const result = validatePeopleHistoryCsv(csv, options());
    expect(result).toEqual({
      ok: false,
      error: 'Row 1 has invalid person ID "dave". Valid person IDs: alice, bob, carol',
    });
  });

  it("rejects a duplicate person ID", () => {
    const csv = ["alice,,0", "alice,,0", "carol,,0"].join("\n");
    const result = validatePeopleHistoryCsv(csv, options());
    expect(result).toEqual({
      ok: false,
      error: 'Duplicate person ID "alice" found at row 2. Person was already seen at row 1.',
    });
  });

  it("rejects a group shift type in history (items only)", () => {
    const csv = ["alice,ALL_SHIFTS,3", "bob,,0", "carol,,0"].join("\n");
    const result = validatePeopleHistoryCsv(
      csv,
      options({ validShiftTypeItemIds: VALID_SHIFT_TYPE_ITEM_IDS }),
    );
    expect(result).toEqual({
      ok: false,
      error: 'Invalid shift type "ALL_SHIFTS" at row 1. Valid shift types: DAY, NIGHT',
    });
  });

  it("rejects an invalid (negative) repetition count", () => {
    const csv = ["alice,DAY,-1", "bob,,0", "carol,,0"].join("\n");
    const result = validatePeopleHistoryCsv(csv, options());
    expect(result).toEqual({
      ok: false,
      error:
        "Invalid repetition count '-1' for person 'alice' at row 1. Must be a non-negative integer.",
    });
  });

  it("rejects a non-numeric repetition count", () => {
    const csv = ["alice,DAY,abc", "bob,,0", "carol,,0"].join("\n");
    const result = validatePeopleHistoryCsv(csv, options());
    expect(result).toEqual({
      ok: false,
      error:
        "Invalid repetition count 'abc' for person 'alice' at row 1. Must be a non-negative integer.",
    });
  });

  it("wraps a thrown parse error in the verbatim catch message", () => {
    const throwingText = {
      split: () => {
        throw new Error("boom");
      },
    } as unknown as string;
    const result = validatePeopleHistoryCsv(throwingText, options());
    expect(result).toEqual({
      ok: false,
      error: "Error processing people-history CSV file. Please check the file format.",
    });
  });
});
