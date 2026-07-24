import { describe, expect, it } from "vitest";
import { createEmptyScenarioUiState, type RequirementCard } from "@/lib/scenario";
import { applyRequirementPatch } from "./requirement-patch";
import { requirementToForm, buildRequirementShiftTypeDomain } from "./requirements-model";

describe("applyRequirementPatch", () => {
  it("updates from live state and preserves uid, disabled, and applied markers", () => {
    const source: RequirementCard = {
      uid: "req-1",
      shiftType: ["Day"],
      requiredNumPeople: 2,
      qualifiedPeople: ["ALL"],
      date: ["ALL"],
      weight: -25,
      disabled: true,
      applied: true,
    };
    const state = {
      ...createEmptyScenarioUiState(),
      shifts: [{ id: "Day" }],
      cardsByKind: {
        ...createEmptyScenarioUiState().cardsByKind,
        requirements: [source],
      },
    };
    const form = {
      ...requirementToForm(source, buildRequirementShiftTypeDomain(state)),
      requiredNumPeople: 3,
    };

    const next = applyRequirementPatch(state, { type: "update", uid: source.uid, form });

    expect(next.cardsByKind.requirements[0]).toMatchObject({
      uid: "req-1",
      requiredNumPeople: 3,
      disabled: true,
      applied: true,
      weight: -1,
    });
  });
});
