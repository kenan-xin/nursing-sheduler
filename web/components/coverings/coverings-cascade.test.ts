import { describe, expect, it } from "vitest";
import { renameEntity, deleteEntity } from "@/lib/cascade";
import {
  createEmptyScenarioUiState,
  type CoveringCard,
  type ScenarioUiState,
} from "@/lib/scenario";
import { buildCoveringCard, emptyCoveringForm } from "./coverings-model";

// The covering card participates in the shared T07 reference cascade (card-fields
// already maps `coverings`). These tests prove the covering-specific behaviors
// spec 06 / spec 11 require: rename rewrites nested trees; delete prunes and drops
// on an emptied required field; an emptied optional `date` is omitted, not a drop.

function stateWith(card: CoveringCard): ScenarioUiState {
  return {
    ...createEmptyScenarioUiState(),
    rangeStart: "2026-01-01",
    rangeEnd: "2026-01-31",
    staff: [{ id: "P1" }, { id: "P2" }],
    shifts: [{ id: "D" }, { id: "N" }],
    dateGroups: [{ id: "Wk1", members: ["2026-01-01"] }],
    cardsByKind: {
      requirements: [],
      successions: [],
      counts: [],
      affinities: [],
      coverings: [card],
    },
  };
}

const CARD = buildCoveringCard(
  {
    ...emptyCoveringForm(),
    preceptors: ["P1"],
    preceptees: ["P2"],
    shiftTypes: ["D"],
    dates: ["Wk1"],
  },
  "cov-1",
);

describe("rename cascade (AC-CV-11)", () => {
  it("rewrites a renamed person id inside the nested preceptors tree", () => {
    const next = renameEntity(stateWith(CARD), "person", "P1", "Alice");
    expect(next.cardsByKind.coverings[0].preceptors).toEqual([["Alice"]]);
    // Untouched fields keep their shape and the card keeps its identity.
    expect(next.cardsByKind.coverings[0].preceptees).toEqual([["P2"]]);
    expect(next.cardsByKind.coverings[0].uid).toBe("cov-1");
  });

  it("rewrites a renamed shift type inside the nested shiftTypes tree", () => {
    const next = renameEntity(stateWith(CARD), "shift", "D", "Day");
    expect(next.cardsByKind.coverings[0].shiftTypes).toEqual([["Day"]]);
  });

  it("rewrites a renamed date group in the optional date field", () => {
    const next = renameEntity(stateWith(CARD), "date", "Wk1", "Week1");
    expect(next.cardsByKind.coverings[0].date).toEqual(["Week1"]);
  });
});

describe("delete cascade (AC-CV-12, spec 06 FR-RI-11 + covering date rule)", () => {
  it("drops the rule when a required field (preceptors) empties", () => {
    const next = deleteEntity(stateWith(CARD), "person", "P1");
    expect(next.cardsByKind.coverings).toHaveLength(0);
  });

  it("keeps the rule but OMITS date when the only date reference is deleted", () => {
    const next = deleteEntity(stateWith(CARD), "date", "Wk1");
    const covering = next.cardsByKind.coverings[0];
    expect(covering).toBeDefined();
    expect("date" in covering).toBe(false);
  });

  it("prunes a deleted shift type from a multi-member selection without dropping", () => {
    const multi = buildCoveringCard(
      { ...emptyCoveringForm(), preceptors: ["P1"], preceptees: ["P2"], shiftTypes: ["D", "N"] },
      "cov-2",
    );
    const next = deleteEntity(stateWith(multi), "shift", "N");
    expect(next.cardsByKind.coverings[0].shiftTypes).toEqual([["D"]]);
  });
});
