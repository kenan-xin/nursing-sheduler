// Scenario-slice fingerprint coverage (T04).
//
// `fingerprint.ts` owns the single source of truth for WHICH fields make up the
// durable scenario slice: the persist partializer, the zundo temporal partializer,
// the `pickScenario` projection and the dirty check all read `SCENARIO_KEYS`, so a
// newly authored field must be added here to stay visible to dirty detection. These
// tests pin that the temporary-cover slice (d582) is one of those fields.
//
// NOTE (d582 Task 3): the hash-based `computeScenarioFingerprint` hashes the
// Workspace V1 projection, and the temporary-cover slice is only WRITTEN into that
// document by Task 4 (its `buildWorkspaceDocument` emission). Until then a cover
// change is visible at the slice level below — which is what marks the scenario
// dirty — and becomes hash-visible when the Workspace document carries it.

import { describe, expect, it } from "vitest";
import { createEmptyScenarioUiState, type ScenarioUiState } from "@/lib/scenario";
import { makeTemporaryCover } from "@/lib/scenario/test-fixtures";
import { pickScenario, SCENARIO_KEYS, scenarioShallowEqual } from "./fingerprint";

const cover = makeTemporaryCover();

function emptyWithCovers(covers: ScenarioUiState["temporaryCover"]): ScenarioUiState {
  return { ...createEmptyScenarioUiState(), temporaryCover: covers };
}

describe("temporaryCover in the scenario slice", () => {
  it("SCENARIO_KEYS includes temporaryCover", () => {
    expect(SCENARIO_KEYS).toContain("temporaryCover");
  });

  it("pickScenario carries the covers through the projection", () => {
    expect(pickScenario(emptyWithCovers([cover])).temporaryCover).toEqual([cover]);
  });

  it("a cover change changes the fingerprint slice (marks the scenario dirty)", () => {
    const without = emptyWithCovers([]);
    const withCover = { ...without, temporaryCover: [cover] };
    expect(scenarioShallowEqual(without, withCover)).toBe(false);
    // A reference-identical slice is a no-op — the immutable-update discipline the
    // zundo partializer relies on to skip empty history entries.
    const covers = [cover];
    expect(
      scenarioShallowEqual(
        { ...without, temporaryCover: covers },
        { ...without, temporaryCover: covers },
      ),
    ).toBe(true);
  });
});
