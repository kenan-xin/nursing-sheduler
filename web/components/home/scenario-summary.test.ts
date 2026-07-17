import { describe, expect, it } from "vitest";
import { createEmptyScenarioUiState, type ScenarioUiState } from "@/lib/scenario";
import { computeScenarioSummary } from "./scenario-summary";

// Cold-review Major coverage: the Guided step-readiness model must be truthful.
// Dates counts as ready only for a genuinely VALID range (not merely non-empty),
// and "all prerequisites met" is a ready-to-run signal — NOT step completion for
// Generate (a roster only exists after a real run; that is resolved at the card
// layer from run state, so completion never leaks into this scenario summary).

function withRange(start: string, end: string): ScenarioUiState {
  return { ...createEmptyScenarioUiState(), rangeStart: start, rangeEnd: end };
}

/** A scenario with all five setup prerequisites satisfied and a valid range. */
function allPrerequisites(): ScenarioUiState {
  const base = createEmptyScenarioUiState();
  return {
    ...base,
    rangeStart: "2026-02-01",
    rangeEnd: "2026-02-28",
    staff: [{ _k: "p1", id: 1, description: "Nurse A" }],
    shifts: [{ _k: "s1", id: "AM", description: "Morning" }],
    reqData: [{ uid: "r1", kind: "leave", person: 1, date: "2026-02-03" }],
    cardsByKind: {
      ...base.cardsByKind,
      requirements: [{ uid: "c1", shiftType: "AM", requiredNumPeople: 1, weight: 1 }],
    },
  };
}

describe("computeScenarioSummary — date-range readiness", () => {
  it("marks Dates ready and counts days for a valid range", () => {
    const s = computeScenarioSummary(withRange("2026-02-01", "2026-02-28"));
    expect(s.ready.dates).toBe(true);
    expect(s.durationDays).toBe(28);
    expect(s.rosterMonthLabel).toBe("February 2026");
  });

  it("does NOT mark Dates ready for a reversed range", () => {
    const s = computeScenarioSummary(withRange("2026-02-28", "2026-02-01"));
    expect(s.ready.dates).toBe(false);
    expect(s.durationDays).toBe(0);
  });

  it("does NOT mark Dates ready for a malformed/non-real range", () => {
    const overflow = computeScenarioSummary(withRange("2026-02-31", "2026-03-05"));
    expect(overflow.ready.dates).toBe(false);
    const garbage = computeScenarioSummary(withRange("2026-13-01", "2026-14-01"));
    expect(garbage.ready.dates).toBe(false);
  });

  it("does NOT mark Dates ready for a non-empty but incomplete range", () => {
    const s = computeScenarioSummary(withRange("2026-02-01", ""));
    expect(s.ready.dates).toBe(false);
    expect(s.rosterMonthLabel).toBe("February 2026");
  });
});

describe("computeScenarioSummary — prerequisites vs Generate completion", () => {
  it("reports all prerequisites met without asserting Generate completion", () => {
    const s = computeScenarioSummary(allPrerequisites());
    expect(s.ready).toEqual({
      dates: true,
      people: true,
      shiftTypes: true,
      rules: true,
      requests: true,
    });
    expect(s.prerequisitesMet).toBe(true);
    // The summary carries no Generate/step-6 completion — that is a run fact,
    // resolved at the card layer, so it can never falsely read as Done here.
    expect(s).not.toHaveProperty("ready.generate");
    expect(s).not.toHaveProperty("readyCount");
  });

  it("is not prerequisitesMet when the range is invalid even if everything else is set", () => {
    const s = computeScenarioSummary({ ...allPrerequisites(), rangeStart: "", rangeEnd: "" });
    expect(s.ready.dates).toBe(false);
    expect(s.prerequisitesMet).toBe(false);
  });
});
