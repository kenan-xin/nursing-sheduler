// Person-history rule (FR-RI-09) — the delete cascade truncates at a deleted
// shift-type id and the import path repairs the blank slots an earlier build left.
// History is right-anchored: the last entry is the day before the schedule starts,
// and succession matching only consults suffixes, so the newest unusable entry
// makes every older entry unusable too.

import { describe, expect, it } from "vitest";
import { truncateHistoryAfterUnusable, truncateHistoryAtBlankEntries } from "./person-history";

describe("truncateHistoryAfterUnusable", () => {
  it("keeps a history with no unusable entry", () => {
    expect(truncateHistoryAfterUnusable(["D", "N"], (id) => id === "A")).toEqual(["D", "N"]);
    expect(truncateHistoryAfterUnusable([], (id) => id === "A")).toEqual([]);
  });

  it("keeps only the entries newer than the newest unusable entry", () => {
    expect(truncateHistoryAfterUnusable(["D", "N", "D", "A"], (id) => id === "D")).toEqual(["A"]);
    expect(truncateHistoryAfterUnusable(["A", "D", "N", "E"], (id) => id === "D")).toEqual([
      "N",
      "E",
    ]);
  });

  it("drops the whole history when the newest entry is unusable", () => {
    expect(truncateHistoryAfterUnusable(["D", "N"], (id) => id === "N")).toEqual([]);
  });
});

describe("truncateHistoryAtBlankEntries", () => {
  it("repairs the blank slots an earlier build's deletion left behind", () => {
    expect(truncateHistoryAtBlankEntries(["", "N", "", "A"])).toEqual(["A"]);
    expect(truncateHistoryAtBlankEntries(["D", "N"])).toEqual(["D", "N"]);
  });
});
