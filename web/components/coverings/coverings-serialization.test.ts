import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  createEmptyScenarioUiState,
  serializeScenario,
  PREFERENCE_TYPE,
  type CoveringCard,
  type ScenarioUiState,
} from "@/lib/scenario";
import { buildCoveringCard, emptyCoveringForm } from "./coverings-model";

// A minimal producer-valid scenario carrying one covering card. Everything the
// strict producer schema requires (a valid ISO range, entity items) is present so
// `serializeScenario` runs the real T05 boundary (project → canonicalize → produce
// → YAML dump) — the oracle for the empty-dates → omitted round-trip.
function scenarioWithCovering(
  card: CoveringCard,
  shifts: ScenarioUiState["shifts"] = [{ id: "D" }],
): ScenarioUiState {
  return {
    ...createEmptyScenarioUiState(),
    rangeStart: "2026-01-01",
    rangeEnd: "2026-01-31",
    staff: [{ id: "Anna" }, { id: "Lil" }],
    shifts,
    cardsByKind: {
      requirements: [],
      successions: [],
      counts: [],
      affinities: [],
      coverings: [card],
    },
  };
}

function coveringPreference(yaml: string): Record<string, unknown> {
  const doc = parse(yaml) as { preferences: Array<Record<string, unknown>> };
  const covering = doc.preferences.find((p) => p.type === PREFERENCE_TYPE.shiftTypeCovering);
  expect(covering, "a shift type covering preference is present in the dump").toBeDefined();
  return covering as Record<string, unknown>;
}

describe("empty-dates → OMITTED via the T05 serialization boundary (FR-CV-12, DL08)", () => {
  it("a covering with no selected dates serializes with NO date key (= all dates)", () => {
    const card = buildCoveringCard(
      { ...emptyCoveringForm(), preceptors: ["Anna"], preceptees: ["Lil"], shiftTypes: ["D"] },
      "uid-empty",
    );
    const yaml = serializeScenario(scenarioWithCovering(card));
    const covering = coveringPreference(yaml);

    expect("date" in covering).toBe(false);
    // Never a no-op empty list.
    expect(yaml).not.toContain("date: []");
    // The canonical single-equation shape survives the dump.
    expect(covering.preceptors).toEqual([["Anna"]]);
    expect(covering.preceptees).toEqual([["Lil"]]);
    expect(covering.shiftTypes).toEqual([["D"]]);
    // The inert weight is stamped and serialized.
    expect(covering.weight).toBe(1);
  });

  it("a covering with selected dates serializes an explicit flat date array", () => {
    const card = buildCoveringCard(
      {
        ...emptyCoveringForm(),
        preceptors: ["Anna"],
        preceptees: ["Lil"],
        shiftTypes: ["D"],
        dates: ["2026-01-01", "2026-01-02"],
      },
      "uid-dated",
    );
    const covering = coveringPreference(serializeScenario(scenarioWithCovering(card)));
    expect(covering.date).toEqual(["2026-01-01", "2026-01-02"]);
  });
});

// The durable edge case: an IMPORTED covering may carry an explicit empty `date: []`
// (normalize preserves it). Vendored `load_data` treats `[]` as NO dates while an
// omitted/`None` date means ALL dates (preference_types.py:671-676), so a load→save
// round-trip would silently flip "all dates" to "no dates" unless the T05 boundary
// drops the empty array during canonicalization.
describe("explicit empty date:[] is dropped at the T05 boundary (= all dates)", () => {
  it("a covering carrying date:[] serializes with NO date key", () => {
    const card: CoveringCard = {
      uid: "uid-empty-array",
      date: [],
      preceptors: [["Anna"]],
      preceptees: [["Lil"]],
      shiftTypes: [["D"]],
      weight: 1,
    };
    const yaml = serializeScenario(scenarioWithCovering(card));
    const covering = coveringPreference(yaml);

    expect("date" in covering).toBe(false);
    expect(yaml).not.toContain("date: []");
  });
});

// A numeric shift-type entity id is a valid `ShiftTypeId`, but preference selectors
// are string-only in the backend (`models.ShiftTypeCoveringPreference.shiftTypes` is
// `list[str | list[str]]`). The editor must prevent a numeric id from becoming a
// selector, so a scenario containing a numeric shift entity still serializes a
// string-only covering card without throwing.
describe("numeric shift-type entities cannot be covering selectors", () => {
  it("a string-only card serializes without throwing even with a numeric shift present", () => {
    const card = buildCoveringCard(
      {
        ...emptyCoveringForm(),
        preceptors: ["Anna"],
        preceptees: ["Lil"],
        shiftTypes: ["D"],
      },
      "uid-str",
    );
    expect(() =>
      serializeScenario(scenarioWithCovering(card, [{ id: 7 }, { id: "D" }])),
    ).not.toThrow();
  });
});
