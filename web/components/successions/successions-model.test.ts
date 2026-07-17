import { describe, expect, it } from "vitest";
import {
  createEmptyScenarioUiState,
  type ScenarioUiState,
  type SuccessionCard,
} from "@/lib/scenario";
import {
  buildPatternShiftTypeOptions,
  buildPeopleTransferOptions,
  buildSuccessionCard,
  emptySuccessionForm,
  flattenPattern,
  isAdvancedSuccessionCard,
  isEditableSuccessionCard,
  isInSelection,
  patternPositionsForDisplay,
  reorderByDrop,
  successionToForm,
  summarizeRefs,
  SUCCESSION_MESSAGES,
  toggleInSelection,
  validateSuccessionForm,
  withCardDisabled,
  type SuccessionFormState,
} from "./successions-model";

function scenario(overrides: Partial<ScenarioUiState> = {}): ScenarioUiState {
  return { ...createEmptyScenarioUiState(), ...overrides };
}

function form(overrides: Partial<SuccessionFormState> = {}): SuccessionFormState {
  return { ...emptySuccessionForm(), ...overrides };
}

const BASE = scenario({
  staff: [{ id: "Anna" }, { id: "Lil" }],
  shifts: [{ id: "N" }, { id: "AM" }, { id: "PM" }],
  shiftGroups: [{ id: "Seniors", members: ["N", "AM"] }],
});

describe("emptySuccessionForm defaults (spec 05 FR-PR-30)", () => {
  it("matches the documented defaults", () => {
    expect(emptySuccessionForm()).toEqual({
      description: "",
      person: [],
      pattern: [],
      date: [],
      weight: -1,
    });
  });
});

describe("selection helpers", () => {
  it("toggle adds then removes by exact identity, order-preserving", () => {
    expect(toggleInSelection([], "Anna")).toEqual(["Anna"]);
    expect(toggleInSelection(["Anna", "Lil"], "Anna")).toEqual(["Lil"]);
    expect(isInSelection(["Anna"], "Anna")).toBe(true);
  });

  it('exact identity keeps numeric 1 and string "1" distinct', () => {
    expect(isInSelection<number | string>([1], "1")).toBe(false);
    expect(isInSelection<number | string>([1], 1)).toBe(true);
    expect(toggleInSelection<number | string>([1], "1")).toEqual([1, "1"]);
  });
});

describe("buildPatternShiftTypeOptions (FR-PR-32, EDGE-PR-08 — OFF/LEAVE/ALL included)", () => {
  it("includes OFF/LEAVE as enabled items and ALL as an enabled group", () => {
    const options = buildPatternShiftTypeOptions(BASE);
    const off = options.items.find((o) => o.value === "OFF");
    const leave = options.items.find((o) => o.value === "LEAVE");
    const all = options.groups.find((o) => o.value === "ALL");
    expect(off?.disabled).toBeUndefined();
    expect(leave?.disabled).toBeUndefined();
    expect(all?.disabled).toBeUndefined();
  });

  it("disables a numeric shift-type entity id with an actionable reason", () => {
    const state = scenario({ shifts: [{ id: 7 }, { id: "N" }] });
    const options = buildPatternShiftTypeOptions(state);
    const numeric = options.items.find((o) => o.value === 7);
    expect(numeric?.disabled).toBe(true);
    expect(numeric?.disabledReason).toBe(SUCCESSION_MESSAGES.numericShiftId);
  });

  it("surfaces authored shift groups alongside the synthetic ALL group", () => {
    const options = buildPatternShiftTypeOptions(BASE);
    expect(options.groups.map((g) => g.value)).toEqual(["Seniors", "ALL"]);
  });
});

describe("buildPeopleTransferOptions", () => {
  it("lists staff items and people groups", () => {
    const options = buildPeopleTransferOptions(BASE);
    expect(options.items.map((o) => o.value)).toEqual(["Anna", "Lil"]);
  });
});

describe("validateSuccessionForm (spec 05 'Shift Type Successions' validation table)", () => {
  it("requires person, a 2+ entry pattern, and dates; a valid weight passes", () => {
    expect(validateSuccessionForm(form())).toEqual({
      person: SUCCESSION_MESSAGES.person,
      pattern: SUCCESSION_MESSAGES.pattern,
      date: SUCCESSION_MESSAGES.date,
    });
  });

  it("rejects a single-entry pattern (AC-PR-11 — minimum 2)", () => {
    const errors = validateSuccessionForm(
      form({ person: ["Anna"], pattern: ["N"], date: ["2026-01-01"] }),
    );
    expect(errors.pattern).toBe(SUCCESSION_MESSAGES.pattern);
  });

  it("accepts a duplicate-bearing 2+ entry pattern", () => {
    const errors = validateSuccessionForm(
      form({ person: ["Anna"], pattern: ["N", "N"], date: ["2026-01-01"] }),
    );
    expect(errors.pattern).toBeUndefined();
  });

  it("rejects an invalid (string) weight and accepts +/-Infinity", () => {
    const invalid = form({
      person: ["Anna"],
      pattern: ["N", "AM"],
      date: ["2026-01-01"],
      weight: "abc",
    });
    expect(validateSuccessionForm(invalid).weight).toBe(SUCCESSION_MESSAGES.weightInvalid);

    const infinite = form({
      person: ["Anna"],
      pattern: ["N", "AM"],
      date: ["2026-01-01"],
      weight: Infinity,
    });
    expect(validateSuccessionForm(infinite).weight).toBeUndefined();
  });

  it("returns no errors for a fully valid draft", () => {
    const valid = form({ person: ["Anna"], pattern: ["N", "AM"], date: ["2026-01-01"] });
    expect(validateSuccessionForm(valid)).toEqual({});
  });
});

describe("buildSuccessionCard / successionToForm round-trip (spec 05 FR-PR-30..34)", () => {
  it("builds a card verbatim from a valid draft, preserving pattern order", () => {
    const draft = form({
      description: "Forbid Evening -> Day",
      person: ["Anna", "Lil"],
      pattern: ["PM", "AM", "N"],
      date: ["2026-01-01", "2026-01-02"],
      weight: -5,
    });
    const card = buildSuccessionCard(draft, "succ-1");
    expect(card).toEqual({
      uid: "succ-1",
      description: "Forbid Evening -> Day",
      person: ["Anna", "Lil"],
      pattern: ["PM", "AM", "N"],
      date: ["2026-01-01", "2026-01-02"],
      weight: -5,
    });
  });

  it("stores an empty description as-is (never trimmed/omitted — FR-PR-04)", () => {
    const card = buildSuccessionCard(
      form({ person: ["Anna"], pattern: ["N", "AM"], date: ["2026-01-01"] }),
    );
    expect(card.description).toBe("");
  });

  it("round-trips a saved card back into an equivalent form draft", () => {
    const card: SuccessionCard = {
      uid: "succ-2",
      description: "desc",
      person: ["Anna"],
      pattern: ["N", "AM", "N"],
      date: ["2026-01-01"],
      weight: 2,
    };
    expect(successionToForm(card)).toEqual({
      description: "desc",
      person: ["Anna"],
      pattern: ["N", "AM", "N"],
      date: ["2026-01-01"],
      weight: 2,
    });
  });

  it("normalizes a scalar person/date on load into single-element arrays", () => {
    const card = {
      uid: "succ-3",
      person: "ALL",
      pattern: ["N", "AM"],
      date: "2026-01-01",
      weight: -1,
    } as unknown as SuccessionCard;
    const loaded = successionToForm(card);
    expect(loaded.person).toEqual(["ALL"]);
    expect(loaded.date).toEqual(["2026-01-01"]);
  });

  it("defaults an undefined date to an empty array on load", () => {
    const card = {
      uid: "succ-4",
      person: ["Anna"],
      pattern: ["N", "AM"],
      weight: -1,
    } as SuccessionCard;
    expect(successionToForm(card).date).toEqual([]);
  });
});

describe("flattenPattern (defensive load — mirrors coverings' flattenRefs)", () => {
  it("is a no-op for the flat sequence this editor authors", () => {
    expect(flattenPattern(["N", "AM", "N"])).toEqual(["N", "AM", "N"]);
  });

  it("flattens a foreign/imported nested position rather than throwing", () => {
    expect(flattenPattern([["N"], "AM", ["PM", "N"]])).toEqual(["N", "AM", "PM", "N"]);
  });
});

describe("advanced (nested-aggregate) pattern detection (Major 1 — C3 lossless fallback)", () => {
  const scalarCard: SuccessionCard = {
    uid: "succ-scalar",
    person: ["Anna"],
    pattern: ["N", "AM", "N"],
    date: ["2026-01-01"],
    weight: -1,
  };
  const nestedCard: SuccessionCard = {
    uid: "succ-nested",
    person: ["Anna"],
    // A nested-aggregate position: "an N-or-AM day, then a PM day".
    pattern: [["N", "AM"], "PM"],
    date: ["2026-01-01"],
    weight: -1,
  };

  it("flags a card with a nested-aggregate position as advanced / not editable", () => {
    expect(isAdvancedSuccessionCard(nestedCard)).toBe(true);
    expect(isEditableSuccessionCard(nestedCard)).toBe(false);
  });

  it("treats an all-scalar pattern (this editor's own output) as editable", () => {
    expect(isAdvancedSuccessionCard(scalarCard)).toBe(false);
    expect(isEditableSuccessionCard(scalarCard)).toBe(true);
    // A single-position pattern (still all-scalar) is editable too.
    expect(isEditableSuccessionCard({ ...scalarCard, pattern: ["N"] })).toBe(true);
  });

  it("preserves a nested-aggregate pattern byte-for-byte through a deep clone (duplicate/save path)", () => {
    // Duplicate/reorder/disable/save route through structuredClone, never
    // `flattenPattern`/`buildSuccessionCard` — so the aggregate survives intact.
    const cloned = structuredClone(nestedCard);
    expect(cloned.pattern).toEqual([["N", "AM"], "PM"]);
    // `withCardDisabled` also leaves the pattern untouched.
    expect(withCardDisabled(nestedCard, true).pattern).toEqual([["N", "AM"], "PM"]);
  });
});

describe("patternPositionsForDisplay (FR-PR-34 — faithful position rendering)", () => {
  it("renders each scalar position as its id, in order", () => {
    expect(patternPositionsForDisplay(["PM", "AM", "N"])).toEqual(["PM", "AM", "N"]);
  });

  it("renders a nested-aggregate position with its terms joined by ' + ' (never flattened)", () => {
    expect(patternPositionsForDisplay([["N", "AM"], "PM"])).toEqual(["N + AM", "PM"]);
  });
});

describe("summarizeRefs", () => {
  it("comma-joins a list and stringifies a lone scalar", () => {
    expect(summarizeRefs(["Anna", "Lil"])).toBe("Anna, Lil");
    expect(summarizeRefs("ALL")).toBe("ALL");
  });
});

describe("reorderByDrop (FR-PR-12 — pointer-half drop position)", () => {
  const list = [{ uid: "a" }, { uid: "b" }, { uid: "c" }];

  it("inserts BEFORE the target on an upper-half drop", () => {
    expect(reorderByDrop(list, "a", "c", "before").map((c) => c.uid)).toEqual(["b", "a", "c"]);
  });

  it("inserts AFTER the target on a lower-half drop", () => {
    expect(reorderByDrop(list, "a", "c", "after").map((c) => c.uid)).toEqual(["b", "c", "a"]);
  });

  it("is a no-op when the source and target are the same card", () => {
    expect(reorderByDrop(list, "a", "a", "before").map((c) => c.uid)).toEqual(["a", "b", "c"]);
  });
});

describe("withCardDisabled", () => {
  it("sets the marker, then strips it (not merely false) when re-enabled", () => {
    const card: SuccessionCard = {
      uid: "succ-5",
      person: ["Anna"],
      pattern: ["N", "AM"],
      date: ["2026-01-01"],
      weight: -1,
    };
    const disabled = withCardDisabled(card, true);
    expect(disabled.disabled).toBe(true);
    const reenabled = withCardDisabled(disabled, false);
    expect(reenabled.disabled).toBeUndefined();
    expect("disabled" in reenabled).toBe(false);
  });
});
