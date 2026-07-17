import { describe, expect, it } from "vitest";
import { createEmptyScenarioUiState, type ScenarioUiState } from "@/lib/scenario";
import { applyRangeChange } from "./range-cascade";

function seeded(): ScenarioUiState {
  const state = createEmptyScenarioUiState("alpha");
  state.rangeStart = "2026-07-01";
  state.rangeEnd = "2026-07-31";
  // A user group referencing same-month DD ids, plus a shift-request matrix cell
  // on one of those dates and an export column that counts it.
  state.dateGroups = [{ id: "Custom", members: ["01", "15", "31"] }];
  state.staff = [{ id: "P1" }];
  state.shifts = [{ id: "D" }];
  state.reqData = [{ kind: "request", person: "P1", date: "15", shiftType: "D", weight: 1 }];
  state.exportLayout = {
    formatting: [],
    extraColumns: [
      { type: "count", header: "Jul", countShiftTypes: ["D"], countDates: ["01", "15"] },
    ],
    extraRows: [],
  };
  return state;
}

describe("applyRangeChange range cascade (FR-DC-41 / AC-DC-18)", () => {
  it("re-keys ids on a span change and strips removed ids from groups + references", () => {
    const next = applyRangeChange(seeded(), { start: "2026-07-01", end: "2026-08-15" });

    // Same-month DD ids no longer exist under a cross-month (MM-DD) span, so the
    // custom group's members and the matrix cell referencing them are purged.
    expect(next.rangeStart).toBe("2026-07-01");
    expect(next.rangeEnd).toBe("2026-08-15");
    expect(next.dateGroups[0].members).toEqual([]);
    expect(next.reqData).toEqual([]);
    // The export column lost every date ref → dropped by the delete cascade.
    expect(next.exportLayout.extraColumns).toEqual([]);
  });

  it("keeps still-generated ids when the span format is unchanged", () => {
    // Shrinking within the same month keeps DD ids; only dropped days are purged.
    const next = applyRangeChange(seeded(), { start: "2026-07-01", end: "2026-07-20" });
    expect(next.dateGroups[0].members).toEqual(["01", "15"]); // 31 removed, 01/15 kept
    expect(next.reqData).toHaveLength(1); // cell on "15" survives
  });

  it("imports WORKDAY/NON-WORKDAY/PH when requested and the range is supported", () => {
    const next = applyRangeChange(
      seeded(),
      { start: "2026-05-01", end: "2026-05-31" },
      {
        importSingaporeHolidays: true,
      },
    );
    const ids = next.dateGroups.map((g) => g.id);
    expect(ids).toContain("WORKDAY");
    expect(ids).toContain("NON-WORKDAY");
    expect(ids).toContain("PH");
    // Labour Day (May 1) is a DD id "01" in a same-month span and lands in PH.
    const ph = next.dateGroups.find((g) => g.id === "PH")!;
    expect(ph.members).toContain("01");
  });

  it("does not import when the range is outside the supported window", () => {
    const next = applyRangeChange(
      seeded(),
      { start: "2020-01-01", end: "2020-01-31" },
      {
        importSingaporeHolidays: true,
      },
    );
    expect(next.dateGroups.map((g) => g.id)).not.toContain("PH");
  });
});
