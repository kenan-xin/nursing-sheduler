import { describe, expect, it } from "vitest";
import {
  affectedPersonNames,
  formatUncreditedLeaveWarning,
  formatUncreditedLeaveWarnings,
} from "./warning-format";
import type { CountCardBody, UiPerson } from "../types";

const STAFF: readonly UiPerson[] = [{ id: "Alice" }, { id: "Bob" }, { id: "Carol" }];
const COUNT = {
  tag: "contracted_hours",
  policy: "exact",
  person: "ALL",
  countDates: "ALL",
  countShiftTypes: "D",
  expression: "==",
  target: 1,
  weight: -1,
} satisfies CountCardBody;

describe("affectedPersonNames", () => {
  it("maps ascending indices to ids in scenario (staff declaration) order", () => {
    expect(affectedPersonNames([0, 2], STAFF)).toEqual(["Alice", "Carol"]);
  });

  it("preserves the finding's index order (already staff-declaration order)", () => {
    expect(affectedPersonNames([1, 2], STAFF)).toEqual(["Bob", "Carol"]);
  });

  it("drops an index with no matching person defensively", () => {
    expect(affectedPersonNames([0, 9], STAFF)).toEqual(["Alice"]);
  });

  it("returns an empty list for no indices", () => {
    expect(affectedPersonNames([], STAFF)).toEqual([]);
  });
});

describe("formatUncreditedLeaveWarning", () => {
  it("names one affected person", () => {
    const line = formatUncreditedLeaveWarning(["Alice"]);
    expect(line).toContain("LEAVE");
    expect(line).toContain("Alice");
  });

  it("joins multiple names with a comma in order", () => {
    expect(formatUncreditedLeaveWarning(["Alice", "Carol"])).toContain("Alice, Carol");
  });

  it("is deterministic for the same names", () => {
    expect(formatUncreditedLeaveWarning(["Alice"])).toBe(formatUncreditedLeaveWarning(["Alice"]));
  });
});

describe("formatUncreditedLeaveWarnings", () => {
  it("emits one line per finding, mapping indices to names", () => {
    const lines = formatUncreditedLeaveWarnings(
      [
        { countIndex: 0, affectedPersonIndices: [0] },
        { countIndex: 1, affectedPersonIndices: [1, 2] },
      ],
      STAFF,
      [{ ...COUNT, description: "Night coverage" }, COUNT],
    );
    expect(lines).toEqual([
      `"Night coverage" (count 1): ${formatUncreditedLeaveWarning(["Alice"])}`,
      `Count 2: ${formatUncreditedLeaveWarning(["Bob", "Carol"])}`,
    ]);
  });

  it("keeps distinct counts with identical descriptions and people unambiguous", () => {
    const lines = formatUncreditedLeaveWarnings(
      [
        { countIndex: 0, affectedPersonIndices: [0] },
        { countIndex: 1, affectedPersonIndices: [0] },
        { countIndex: 2, affectedPersonIndices: [0] },
      ],
      STAFF,
      [
        { ...COUNT, description: "Night coverage" },
        { ...COUNT, description: "Night coverage" },
        COUNT,
      ],
    );
    expect(lines.map((line) => line.split(":")[0])).toEqual([
      '"Night coverage" (count 1)',
      '"Night coverage" (count 2)',
      "Count 3",
    ]);
  });

  it("deduplicates only identical count and person lines while preserving order", () => {
    const lines = formatUncreditedLeaveWarnings(
      [
        { countIndex: 0, affectedPersonIndices: [0] },
        { countIndex: 0, affectedPersonIndices: [0] },
      ],
      STAFF,
      [COUNT],
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Alice");
  });

  it("skips a finding whose affected people cannot be named", () => {
    const lines = formatUncreditedLeaveWarnings(
      [{ countIndex: 0, affectedPersonIndices: [9] }],
      STAFF,
      [COUNT],
    );
    expect(lines).toEqual([]);
  });
});
