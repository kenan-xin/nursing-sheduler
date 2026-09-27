// Scenario-slice fingerprint coverage (T04).
//
// `fingerprint.ts` owns the single source of truth for WHICH fields make up the
// durable scenario slice: the persist partializer, the zundo temporal partializer,
// the `pickScenario` projection and the dirty check all read `SCENARIO_KEYS`, so a
// newly authored field must be added here to stay visible to dirty detection. These
// tests pin that the temporary-cover slice (d582) is one of those fields.
//
// `computeScenarioFingerprint` hashes the Workspace V1 projection. Task 3 added the
// slice; Task 4 made `buildWorkspaceDocument` emit a non-empty `temporaryCover`, so
// a cover change is now visible at the HASH level too (not only at the slice level).

import { describe, expect, it } from "vitest";
import { createEmptyScenarioUiState, type ScenarioUiState } from "@/lib/scenario";
import { makeTemporaryCover } from "@/lib/scenario/test-fixtures";
import {
  computeScenarioFingerprint,
  pickScenario,
  SCENARIO_KEYS,
  scenarioShallowEqual,
} from "./fingerprint";

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

  it("a cover change changes the fingerprint hash", () => {
    // The Workspace V1 projection carries `temporaryCover` (d582 Task 4), so the
    // backup-freshness hash moves when a cover is added or removed.
    expect(computeScenarioFingerprint(emptyWithCovers([cover]))).not.toBe(
      computeScenarioFingerprint(emptyWithCovers([])),
    );
  });
});
