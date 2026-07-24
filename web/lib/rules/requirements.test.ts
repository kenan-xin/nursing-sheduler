import { describe, expect, it } from "vitest";
import {
  createEmptyScenarioUiState,
  type RequirementCard,
  type ScenarioUiState,
} from "@/lib/scenario";
import { requirementsForShiftType } from "./requirements";

/** A minimal valid requirement card (only `shiftType` varies across tests). */
function req(
  uid: string,
  shiftType: RequirementCard["shiftType"],
  extra: Partial<RequirementCard> = {},
): RequirementCard {
  return { uid, shiftType, requiredNumPeople: 1, weight: -1, ...extra };
}

// Shifts D, N, a numeric-id shift 5, plus an uncovered shift X. Groups: Days={D},
// Both={D,N}, Nested={Days} (so Nested → Days → D).
function state(requirements: RequirementCard[]): ScenarioUiState {
  const base = createEmptyScenarioUiState();
  return {
    ...base,
    shifts: [{ id: "D" }, { id: "N" }, { id: 5 }, { id: "X" }],
    shiftGroups: [
      { id: "Days", members: ["D"] },
      { id: "Both", members: ["D", "N"] },
      { id: "Nested", members: ["Days"] },
    ],
    cardsByKind: { ...base.cardsByKind, requirements },
  };
}

describe("requirementsForShiftType — classified, group-expanding reverse index (DR-H)", () => {
  it("classifies a single literal target as DIRECT-SIMPLE", () => {
    const s = state([req("r1", "D")]);
    const hits = requirementsForShiftType(s, "D");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ index: 0, kind: "DIRECT-SIMPLE", coveredShiftTypes: ["D"] });
    expect(hits[0].card.uid).toBe("r1");
  });

  it("classifies a single-shift group as GROUP-DERIVED", () => {
    const hits = requirementsForShiftType(state([req("r1", "Days")]), "D");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: "GROUP-DERIVED", coveredShiftTypes: ["D"] });
  });

  it("classifies a group that covers several shift types as MULTI-TARGET", () => {
    const hits = requirementsForShiftType(state([req("r1", "Both")]), "D");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: "MULTI-TARGET", coveredShiftTypes: ["D", "N"] });
    // The same card also covers N (still MULTI-TARGET).
    expect(requirementsForShiftType(state([req("r1", "Both")]), "N")[0].kind).toBe("MULTI-TARGET");
  });

  it("expands a NESTED group (Nested → Days → D) as GROUP-DERIVED", () => {
    const hits = requirementsForShiftType(state([req("r1", "Nested")]), "D");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: "GROUP-DERIVED", coveredShiftTypes: ["D"] });
  });

  it("classifies an explicit multi-ref list as MULTI-TARGET", () => {
    const hits = requirementsForShiftType(state([req("r1", ["D", "N"])]), "D");
    expect(hits[0]).toMatchObject({ kind: "MULTI-TARGET", coveredShiftTypes: ["D", "N"] });
  });

  it("excludes a disabled card entirely", () => {
    const s = state([req("r1", "D", { disabled: true }), req("r2", "D")]);
    const hits = requirementsForShiftType(s, "D");
    expect(hits).toHaveLength(1);
    expect(hits[0].card.uid).toBe("r2");
    expect(hits[0].index).toBe(1);
  });

  it("matches a numeric-id shift referenced by its string id (DIRECT-SIMPLE)", () => {
    const s = state([req("r1", "5")]);
    // Query by the numeric id or its string form — both resolve.
    expect(requirementsForShiftType(s, 5)[0]).toMatchObject({ kind: "DIRECT-SIMPLE" });
    expect(requirementsForShiftType(s, "5")[0]).toMatchObject({ kind: "DIRECT-SIMPLE" });
  });

  it("reports a shift covered ONLY by a group (never directly) as GROUP-DERIVED", () => {
    // N is reached only through Both; there is no direct `N` card.
    const hits = requirementsForShiftType(state([req("r1", "Both")]), "N");
    expect(hits[0].kind).toBe("MULTI-TARGET"); // Both covers D+N
    // A single-target group covering only N.
    const s = state([req("r1", "Nights")]);
    s.shiftGroups.push({ id: "Nights", members: ["N"] });
    expect(requirementsForShiftType(s, "N")[0].kind).toBe("GROUP-DERIVED");
  });

  it("returns [] for a shift no requirement covers", () => {
    const s = state([req("r1", "D"), req("r2", "Both")]);
    expect(requirementsForShiftType(s, "X")).toEqual([]);
  });

  it("returns every matching card in list order, each classified", () => {
    const s = state([req("r1", "D"), req("r2", "Days"), req("r3", "Both")]);
    const hits = requirementsForShiftType(s, "D");
    expect(hits.map((h) => [h.index, h.kind])).toEqual([
      [0, "DIRECT-SIMPLE"],
      [1, "GROUP-DERIVED"],
      [2, "MULTI-TARGET"],
    ]);
  });
});
