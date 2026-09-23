import { describe, expect, it } from "vitest";
import { createEmptyScenarioUiState, type RequirementCard } from "@/lib/scenario";
import { applyRequirementPatch } from "./requirement-patch";
import {
  requirementToForm,
  buildRequirementShiftTypeDomain,
  emptyRequirementForm,
} from "./requirements-model";

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

  it("uses a supplied uid for an add, and mints one when none is given", () => {
    const state = { ...createEmptyScenarioUiState(), shifts: [{ id: "Day" }] };
    const form = {
      ...emptyRequirementForm(),
      shiftType: ["Day"],
      qualifiedPeople: ["ALL"],
      date: ["ALL"],
    };
    const given = applyRequirementPatch(state, { type: "add", form, uid: "fixed" });
    expect(given.cardsByKind.requirements.at(-1)?.uid).toBe("fixed");
    const minted = applyRequirementPatch(state, { type: "add", form });
    expect(minted.cardsByKind.requirements.at(-1)?.uid).toMatch(/^[0-9a-f-]{36}$/);
  });
});
