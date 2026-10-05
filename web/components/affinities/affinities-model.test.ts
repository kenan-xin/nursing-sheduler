import { describe, expect, it } from "vitest";
import {
  createEmptyScenarioUiState,
  type AffinityCard,
  type ScenarioUiState,
} from "@/lib/scenario";
import {
  AFFINITY_ANY_MEMBER,
  AFFINITY_ANY_SHIFT,
  AFFINITY_GROUPED_MEANING,
  AFFINITY_MESSAGES,
  AFFINITY_SAME_SHIFT,
  affinityTogetherMeaning,
  affinityToForm,
  buildAffinityCard,
  buildAffinityShiftTypeTransferOptions,
  emptyAffinityForm,
  flattenRefs,
  isAdvancedAffinityCard,
  isEditableAffinityCard,
  isInSelection,
  reorderByDrop,
  summarizeRefs,
  toggleInSelection,
  validateAffinityForm,
  withCardDisabled,
  type AffinityFormState,
} from "./affinities-model";

function scenario(overrides: Partial<ScenarioUiState> = {}): ScenarioUiState {
  return { ...createEmptyScenarioUiState(), ...overrides };
}

function form(overrides: Partial<AffinityFormState> = {}): AffinityFormState {
  return { ...emptyAffinityForm(), ...overrides };
}

const BASE = scenario({
  staff: [{ id: "Chloe" }, { id: "Aisha" }],
  shifts: [{ id: "D" }, { id: "N" }],
  shiftGroups: [{ id: "TeamA", members: ["D", "N"] }],
});

describe("emptyAffinityForm defaults (spec 05 FR-PR-60)", () => {
  it("matches the documented affinity defaults — weight defaults to -100, apart where possible (12z8)", () => {
    expect(emptyAffinityForm()).toEqual({
      description: "",
      people1: [],
      people2: [],
      shiftTypes: [],
      date: [],
      weight: -100,
    });
  });
});

describe("selection helpers", () => {
  it("toggle adds then removes by exact identity, order-preserving", () => {
    expect(toggleInSelection([], "D")).toEqual(["D"]);
    expect(toggleInSelection(["D", "N"], "D")).toEqual(["N"]);
    expect(isInSelection(["D"], "D")).toBe(true);
  });

  it('exact identity keeps numeric 1 and string "1" distinct', () => {
    expect(isInSelection<number | string>([1], "1")).toBe(false);
    expect(isInSelection<number | string>([1], 1)).toBe(true);
    expect(toggleInSelection<number | string>([1], "1")).toEqual([1, "1"]);
  });
});

describe("buildAffinityShiftTypeTransferOptions (FR-PR-61, EDGE-PR-07 — OFF/LEAVE/ALL included)", () => {
  it("includes OFF/LEAVE as enabled items and ALL as an enabled group", () => {
    const options = buildAffinityShiftTypeTransferOptions(BASE);
    const off = options.items.find((o) => o.value === "OFF");
    const leave = options.items.find((o) => o.value === "LEAVE");
    const all = options.groups.find((o) => o.value === "ALL");
    expect(off?.disabled).toBeUndefined();
    expect(leave?.disabled).toBeUndefined();
    expect(all?.disabled).toBeUndefined();
  });

  it("disables a numeric shift-type entity id with an actionable reason", () => {
    const state = scenario({ shifts: [{ id: 7 }, { id: "D" }] });
    const options = buildAffinityShiftTypeTransferOptions(state);
    const numeric = options.items.find((o) => o.value === 7);
    const stringShift = options.items.find((o) => o.value === "D");
    expect(numeric?.disabled).toBe(true);
    expect(numeric?.disabledReason).toBe(AFFINITY_MESSAGES.numericShiftId);
    expect(stringShift?.disabled).toBeUndefined();
  });
});

describe("validateAffinityForm (spec 05 Shift Affinities validation table)", () => {
  it("sets the verbatim empty-selection messages for all four required fields", () => {
    const errors = validateAffinityForm(form());
    expect(errors.people1).toBe(AFFINITY_MESSAGES.people1);
    expect(errors.people2).toBe(AFFINITY_MESSAGES.people2);
    expect(errors.shiftTypes).toBe(AFFINITY_MESSAGES.shiftTypes);
    expect(errors.date).toBe(AFFINITY_MESSAGES.date);
  });

  it("is valid once all four selections are non-empty and weight is a valid number", () => {
    const errors = validateAffinityForm(
      form({ people1: ["Chloe"], people2: ["Aisha"], shiftTypes: ["D"], date: ["ALL"] }),
    );
    expect(errors).toEqual({});
  });

  it("rejects an invalid (unparsed string) weight with the verbatim message", () => {
    const base = form({ people1: ["Chloe"], people2: ["Aisha"], shiftTypes: ["D"], date: ["ALL"] });
    expect(validateAffinityForm({ ...base, weight: "abc" }).weight).toBe(
      `Not a number. ${AFFINITY_MESSAGES.weightInvalid}`,
    );
  });

  it("has NO sign restriction on weight — positive, negative, and both infinities are all valid", () => {
    const base = form({ people1: ["Chloe"], people2: ["Aisha"], shiftTypes: ["D"], date: ["ALL"] });
    expect(validateAffinityForm({ ...base, weight: 1 }).weight).toBeUndefined();
    expect(validateAffinityForm({ ...base, weight: -1 }).weight).toBeUndefined();
    expect(validateAffinityForm({ ...base, weight: Infinity }).weight).toBeUndefined();
    expect(validateAffinityForm({ ...base, weight: -Infinity }).weight).toBeUndefined();
  });
});

describe("buildAffinityCard (spec 05 FR-PR-60/61)", () => {
  it("saves v1's flat people1/people2/shiftTypes lists so core scores each person and shift on its own (rqfx)", () => {
    const card = buildAffinityCard(
      form({ people1: ["Chloe"], people2: ["Aisha"], shiftTypes: ["D"], date: ["2026-01-01"] }),
      "uid-1",
    );
    expect(card.uid).toBe("uid-1");
    expect(card.people1).toEqual(["Chloe"]);
    expect(card.people2).toEqual(["Aisha"]);
    expect(card.shiftTypes).toEqual(["D"]);
    expect(card.date).toEqual(["2026-01-01"]);
    expect(card.weight).toBe(-100);
  });

  it("preserves the authored description verbatim, even empty (FR-PR-04 — shared with Counts)", () => {
    const spaced = buildAffinityCard(
      form({
        people1: ["Chloe"],
        people2: ["Aisha"],
        shiftTypes: ["D"],
        date: ["ALL"],
        description: "  Keep them together  ",
      }),
      "u",
    );
    expect(spaced.description).toBe("  Keep them together  ");
    const empty = buildAffinityCard(
      form({ people1: ["Chloe"], people2: ["Aisha"], shiftTypes: ["D"], date: ["ALL"] }),
      "u2",
    );
    expect(empty.description).toBe("");
  });

  it("keeps numeric and string people/date refs distinct, one element each", () => {
    const card = buildAffinityCard(
      form({ people1: [1, "1"], people2: ["Aisha"], shiftTypes: ["D"], date: [1, "2026-01-01"] }),
      "u3",
    );
    expect(card.people1).toEqual([1, "1"]);
    expect(card.date).toEqual([1, "2026-01-01"]);
  });
});

describe("flattenRefs / summarizeRefs", () => {
  it("flattens a nested tree to a flat list", () => {
    expect(flattenRefs(["Chloe"])).toEqual(["Chloe"]);
    expect(flattenRefs([["Chloe", "Aisha"]])).toEqual(["Chloe", "Aisha"]);
  });

  it("flattens a flat scalar or flat array (the `date` field's shape) to itself", () => {
    expect(flattenRefs("ALL")).toEqual(["ALL"]);
    expect(flattenRefs(["ALL"])).toEqual(["ALL"]);
    expect(flattenRefs(["2026-01-01", "2026-01-02"])).toEqual(["2026-01-01", "2026-01-02"]);
  });

  it("comma-joins the flattened refs for a card summary", () => {
    expect(summarizeRefs([["Chloe", "Aisha"]])).toBe("Chloe, Aisha");
    expect(summarizeRefs(["ALL"])).toBe("ALL");
  });
});

describe("affinityToForm load round-trip", () => {
  it("flattens the nested people1/people2/shiftTypes and the flat date list back to a draft", () => {
    const card: AffinityCard = {
      uid: "u1",
      date: ["ALL"],
      people1: [["Chloe"]],
      people2: [["Aisha"]],
      shiftTypes: [["D"]],
      weight: 30,
    };
    const loaded = affinityToForm(card);
    expect(loaded.people1).toEqual(["Chloe"]);
    expect(loaded.people2).toEqual(["Aisha"]);
    expect(loaded.shiftTypes).toEqual(["D"]);
    expect(loaded.date).toEqual(["ALL"]);
    expect(loaded.weight).toBe(30);
  });

  it("falls back to an empty description when absent", () => {
    const card: AffinityCard = {
      uid: "u2",
      date: ["ALL"],
      people1: [["Chloe"]],
      people2: [["Aisha"]],
      shiftTypes: [["D"]],
      weight: 1,
    };
    expect(affinityToForm(card).description).toBe("");
  });
});

describe("reorderByDrop (FR-PR-12 pointer half)", () => {
  const list = [{ uid: "A" }, { uid: "B" }, { uid: "C" }, { uid: "D" }];

  it("inserts BEFORE the hovered card (upper half)", () => {
    expect(reorderByDrop(list, "A", "C", "before").map((c) => c.uid)).toEqual(["B", "A", "C", "D"]);
  });

  it("inserts AFTER the hovered card (lower half)", () => {
    expect(reorderByDrop(list, "A", "C", "after").map((c) => c.uid)).toEqual(["B", "C", "A", "D"]);
  });

  it("is a no-op when from === to or a uid is missing", () => {
    expect(reorderByDrop(list, "A", "A", "before").map((c) => c.uid)).toEqual(["A", "B", "C", "D"]);
    expect(reorderByDrop(list, "Z", "B", "after").map((c) => c.uid)).toEqual(["A", "B", "C", "D"]);
  });
});

describe("withCardDisabled", () => {
  it("sets and strips the disabled marker without touching other fields", () => {
    const card: AffinityCard = {
      uid: "u",
      date: ["ALL"],
      people1: [["Chloe"]],
      people2: [["Aisha"]],
      shiftTypes: [["D"]],
      weight: 1,
    };
    const off = withCardDisabled(card, true);
    expect(off.disabled).toBe(true);
    const on = withCardDisabled(off, false);
    expect("disabled" in on).toBe(false);
    expect(on.weight).toBe(1);
  });
});

describe("v1-shaped vs grouped affinity detection (rqfx)", () => {
  const v1: AffinityCard = {
    uid: "v1",
    date: ["ALL"],
    people1: ["A", "B"],
    people2: ["C"],
    shiftTypes: ["D", "N"],
    weight: 1,
  };

  it("a v1-shaped (flat, per-element) card loads as an editable card and round-trips", () => {
    expect(isAdvancedAffinityCard(v1)).toBe(false);
    expect(isEditableAffinityCard(v1)).toBe(true);
    const rebuilt = buildAffinityCard(affinityToForm(v1), v1.uid);
    expect(rebuilt).toEqual({ ...v1, description: "" });
  });

  it("one-member groups mean the same as scalars, so they stay editable and save flat", () => {
    const singletons: AffinityCard = { ...v1, people1: [["A"], ["B"]], shiftTypes: [["D"]] };
    expect(isEditableAffinityCard(singletons)).toBe(true);
    const rebuilt = buildAffinityCard(affinityToForm(singletons), singletons.uid);
    expect(rebuilt.people1).toEqual(["A", "B"]);
    expect(rebuilt.shiftTypes).toEqual(["D"]);
  });

  it("a grouped card (pre-rqfx v2 form shape) stays advanced: flattening would change its meaning", () => {
    for (const grouped of [
      { ...v1, people1: [["A", "B"]] },
      { ...v1, people2: [["C", "E"]] },
      { ...v1, shiftTypes: [["D", "N"]] },
    ] as AffinityCard[]) {
      expect(isAdvancedAffinityCard(grouped)).toBe(true);
      expect(isEditableAffinityCard(grouped)).toBe(false);
    }
  });
});

// Bug hunt B2: core scores ALL, a shift group and a staff group as ONE term (v1), so the
// card must not promise "the same shift" for them.
describe("affinityTogetherMeaning", () => {
  const card = (patch: Partial<AffinityCard>): AffinityCard => ({
    uid: "a",
    date: ["ALL"],
    people1: ["A"],
    people2: ["B"],
    shiftTypes: ["D"],
    weight: -Infinity,
    ...patch,
  });
  const groups = scenario({
    staffGroups: [{ id: "Seniors", members: ["A"] }],
    shiftGroups: [{ id: "Any", members: ["D", "N"] }],
  });

  it("keeps 'the same shift' for concrete shifts and people", () => {
    expect(affinityTogetherMeaning(card({ shiftTypes: ["D", "N"] }), groups)).toBe(
      AFFINITY_SAME_SHIFT,
    );
  });

  it.each([["ALL"], ["all"], ["Any"]])("says any shift in %s counts", (shift) => {
    expect(affinityTogetherMeaning(card({ shiftTypes: [shift] }), groups)).toBe(AFFINITY_ANY_SHIFT);
  });

  it("says a staff group counts as one person", () => {
    expect(affinityTogetherMeaning(card({ people2: ["Seniors"] }), groups)).toBe(
      `${AFFINITY_SAME_SHIFT}; ${AFFINITY_ANY_MEMBER}`,
    );
  });

  it("keeps the grouped meaning for an advanced card", () => {
    expect(affinityTogetherMeaning(card({ people1: [["A", "B"]] }), groups)).toBe(
      AFFINITY_GROUPED_MEANING,
    );
  });
});
