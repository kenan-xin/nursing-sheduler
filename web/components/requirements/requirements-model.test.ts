import { describe, expect, it } from "vitest";
import {
  createEmptyScenarioUiState,
  type RequirementCard,
  type ScenarioUiState,
} from "@/lib/scenario";
import {
  REQUIREMENT_MESSAGES,
  buildQualifiedPeopleTransferOptions,
  buildRequirementCard,
  buildRequirementShiftTypeDomain,
  buildRequirementShiftTypeOptions,
  computeCoverageWarnings,
  emptyRequirementForm,
  hasCoverageWarnings,
  preferredDiffersFromRequired,
  reorderByDrop,
  requirementToForm,
  selectShiftType,
  shiftGroupReachesDayState,
  summarizeRefs,
  validateRequirementForm,
  withCardDisabled,
  type RequirementFormState,
} from "./requirements-model";

function scenario(overrides: Partial<ScenarioUiState> = {}): ScenarioUiState {
  return { ...createEmptyScenarioUiState(), ...overrides };
}

function form(overrides: Partial<RequirementFormState> = {}): RequirementFormState {
  return { ...emptyRequirementForm(), ...overrides };
}

const BASE = scenario({
  staff: [{ id: "Anna" }, { id: "Lil" }],
  staffGroups: [{ id: "Seniors", members: ["Anna"] }],
  shifts: [{ id: "D" }, { id: "N" }],
  shiftGroups: [
    { id: "AllWorked", members: ["D", "N"] },
    { id: "RestGroup", members: ["OFF"] },
  ],
});

describe("emptyRequirementForm defaults (spec 05 FR-PR-20)", () => {
  it("matches the documented requirement defaults", () => {
    expect(emptyRequirementForm()).toEqual({
      description: "",
      shiftType: [],
      shiftTypeCoefficients: [],
      requiredNumPeople: 1,
      qualifiedPeople: [],
      preferredNumPeople: "",
      date: [],
      weight: -50,
    });
  });
});

describe("buildQualifiedPeopleTransferOptions (FR-PR-26)", () => {
  it("includes staff, groups, and a synthetic ALL group", () => {
    const options = buildQualifiedPeopleTransferOptions(BASE);
    expect(options.items.map((o) => o.value)).toEqual(["Anna", "Lil"]);
    expect(options.groups.map((o) => o.value)).toEqual(["Seniors", "ALL"]);
  });
});

describe("buildRequirementShiftTypeOptions (FR-PR-21/EDGE-PR-07)", () => {
  it("excludes OFF/LEAVE items entirely", () => {
    const state = scenario({ shifts: [{ id: "D" }, { id: "OFF" }, { id: "LEAVE" }] });
    const options = buildRequirementShiftTypeOptions(state);
    expect(options.items.map((o) => o.value)).toEqual(["D"]);
  });

  it("excludes any group whose members (transitively) reach OFF/LEAVE", () => {
    const options = buildRequirementShiftTypeOptions(BASE);
    expect(options.groups.map((o) => o.value)).toEqual(["AllWorked"]);
  });

  it("excludes a group that reaches OFF/LEAVE via a nested group", () => {
    const state = scenario({
      shifts: [{ id: "D" }],
      shiftGroups: [
        { id: "Inner", members: ["OFF"] },
        { id: "Outer", members: ["Inner"] },
      ],
    });
    expect(shiftGroupReachesDayState("Outer", state)).toBe(true);
    const options = buildRequirementShiftTypeOptions(state);
    expect(options.groups).toEqual([]);
  });

  it("disables a numeric shift-type entity id with an actionable reason", () => {
    const state = scenario({ shifts: [{ id: 7 }, { id: "D" }] });
    const options = buildRequirementShiftTypeOptions(state);
    const numeric = options.items.find((o) => o.value === 7);
    const stringShift = options.items.find((o) => o.value === "D");
    expect(numeric?.disabled).toBe(true);
    expect(numeric?.disabledReason).toBe(REQUIREMENT_MESSAGES.numericShiftId);
    expect(stringShift?.disabled).toBeUndefined();
  });
});

describe("selectShiftType (FR-PR-21 — replace, never accumulate)", () => {
  it("always yields exactly one ref", () => {
    expect(selectShiftType("D")).toEqual(["D"]);
    expect(selectShiftType("AllWorked")).toEqual(["AllWorked"]);
  });
});

describe("buildRequirementShiftTypeDomain coefficient eligibility (FR-PR-70)", () => {
  it("a selected group makes both its member items AND the group itself eligible", () => {
    const domain = buildRequirementShiftTypeDomain(BASE);
    expect(domain.items.map((i) => i.id)).toEqual(["D", "N"]);
    expect(domain.groups.map((g) => g.id)).toEqual(["AllWorked"]);
  });

  it("excludes OFF/LEAVE-reaching groups from the domain entirely", () => {
    const domain = buildRequirementShiftTypeDomain(BASE);
    expect(domain.groups.map((g) => g.id)).not.toContain("RestGroup");
  });
});

describe("preferredDiffersFromRequired (FR-PR-24)", () => {
  it("is false when preferred is unset", () => {
    expect(
      preferredDiffersFromRequired(form({ requiredNumPeople: 3, preferredNumPeople: "" })),
    ).toBe(false);
  });

  it("is false when preferred equals required", () => {
    expect(
      preferredDiffersFromRequired(form({ requiredNumPeople: 3, preferredNumPeople: 3 })),
    ).toBe(false);
  });

  it("is true when preferred differs from required", () => {
    expect(
      preferredDiffersFromRequired(form({ requiredNumPeople: 3, preferredNumPeople: 5 })),
    ).toBe(true);
  });
});

describe("validateRequirementForm (spec 05 Shift Type Requirements validation table)", () => {
  const domain = buildRequirementShiftTypeDomain(BASE);

  it("sets the verbatim empty-selection messages", () => {
    const errors = validateRequirementForm(form(), domain);
    expect(errors.shiftType).toBe(REQUIREMENT_MESSAGES.shiftTypeEmpty);
    expect(errors.qualifiedPeople).toBe(REQUIREMENT_MESSAGES.qualifiedEmpty);
    expect(errors.date).toBe(REQUIREMENT_MESSAGES.dateEmpty);
  });

  it("rejects more than one shift type selected", () => {
    const errors = validateRequirementForm(
      form({ shiftType: ["D", "N"], qualifiedPeople: ["ALL"], date: ["ALL"] }),
      domain,
    );
    expect(errors.shiftType).toBe(REQUIREMENT_MESSAGES.shiftTypeMultiple);
  });

  it("required number of people: blank and negative", () => {
    expect(validateRequirementForm(form({ requiredNumPeople: "" }), domain).requiredNumPeople).toBe(
      REQUIREMENT_MESSAGES.requiredInvalid,
    );
    expect(validateRequirementForm(form({ requiredNumPeople: -1 }), domain).requiredNumPeople).toBe(
      REQUIREMENT_MESSAGES.requiredMin,
    );
  });

  it("preferred number of people: below 1, and below required", () => {
    expect(
      validateRequirementForm(form({ requiredNumPeople: 3, preferredNumPeople: 0 }), domain)
        .preferredNumPeople,
    ).toBe(REQUIREMENT_MESSAGES.preferredMin);
    expect(
      validateRequirementForm(form({ requiredNumPeople: 3, preferredNumPeople: 2 }), domain)
        .preferredNumPeople,
    ).toBe(REQUIREMENT_MESSAGES.preferredLessThanRequired);
  });

  it("weight is validated ONLY when preferred differs from required", () => {
    const equalPref = form({
      shiftType: ["D"],
      qualifiedPeople: ["ALL"],
      date: ["ALL"],
      requiredNumPeople: 3,
      preferredNumPeople: 3,
      weight: 10, // positive — would fail if validated
    });
    expect(validateRequirementForm(equalPref, domain).weight).toBeUndefined();

    const diffPref = form({
      shiftType: ["D"],
      qualifiedPeople: ["ALL"],
      date: ["ALL"],
      requiredNumPeople: 3,
      preferredNumPeople: 5,
      weight: 10, // positive — invalid once weight IS meaningful
    });
    expect(validateRequirementForm(diffPref, domain).weight).toBe(
      REQUIREMENT_MESSAGES.weightPositive,
    );
  });

  it("weight invalid (raw string) message when preferred differs", () => {
    const invalid = form({
      shiftType: ["D"],
      qualifiedPeople: ["ALL"],
      date: ["ALL"],
      requiredNumPeople: 3,
      preferredNumPeople: 5,
      weight: "abc",
    });
    expect(validateRequirementForm(invalid, domain).weight).toBe(
      REQUIREMENT_MESSAGES.weightInvalid,
    );
  });

  it("a valid full draft has no errors", () => {
    const valid = form({
      shiftType: ["D"],
      qualifiedPeople: ["ALL"],
      date: ["ALL"],
      requiredNumPeople: 3,
      preferredNumPeople: "",
      weight: -50,
    });
    expect(validateRequirementForm(valid, domain)).toEqual({});
  });
});

describe("buildRequirementCard (FR-PR-20..26, EDGE-PR-03)", () => {
  const domain = buildRequirementShiftTypeDomain(BASE);

  it("forces weight -1 and omits preferredNumPeople when preferred equals required", () => {
    const card = buildRequirementCard(
      form({
        shiftType: ["D"],
        qualifiedPeople: ["ALL"],
        date: ["ALL"],
        requiredNumPeople: 3,
        preferredNumPeople: 3,
        weight: -99, // must be overridden regardless of what the hidden field held
      }),
      domain,
      "req-1",
    );
    expect(card.weight).toBe(-1);
    expect(card.preferredNumPeople).toBeUndefined();
  });

  it("forces weight -1 and omits preferredNumPeople when preferred is unset", () => {
    const card = buildRequirementCard(
      form({
        shiftType: ["D"],
        qualifiedPeople: ["ALL"],
        date: ["ALL"],
        requiredNumPeople: 3,
        preferredNumPeople: "",
        weight: -50,
      }),
      domain,
      "req-2",
    );
    expect(card.weight).toBe(-1);
    expect(card.preferredNumPeople).toBeUndefined();
  });

  it("saves the entered weight and preferred when they differ from required", () => {
    const card = buildRequirementCard(
      form({
        shiftType: ["D"],
        qualifiedPeople: ["ALL"],
        date: ["ALL"],
        requiredNumPeople: 3,
        preferredNumPeople: 5,
        weight: -10,
      }),
      domain,
      "req-3",
    );
    expect(card.weight).toBe(-10);
    expect(card.preferredNumPeople).toBe(5);
  });

  it("saves an explicit [ALL] for qualifiedPeople (FR-PR-26)", () => {
    const card = buildRequirementCard(
      form({
        shiftType: ["D"],
        qualifiedPeople: ["ALL"],
        date: ["ALL"],
        requiredNumPeople: 1,
      }),
      domain,
      "req-4",
    );
    expect(card.qualifiedPeople).toEqual(["ALL"]);
  });

  it("stores description as-is, even empty (FR-PR-04)", () => {
    const card = buildRequirementCard(
      form({ shiftType: ["D"], qualifiedPeople: ["ALL"], date: ["ALL"], requiredNumPeople: 1 }),
      domain,
      "req-5",
    );
    expect(card.description).toBe("");
  });
});

describe("requirementToForm (FR-PR-26 load — null/undefined → [ALL])", () => {
  const domain = buildRequirementShiftTypeDomain(BASE);

  it("normalizes an undefined qualifiedPeople/date to [ALL]", () => {
    const card: RequirementCard = {
      uid: "u1",
      shiftType: ["D"],
      requiredNumPeople: 2,
      weight: -1,
    };
    const loaded = requirementToForm(card, domain);
    expect(loaded.qualifiedPeople).toEqual(["ALL"]);
    expect(loaded.date).toEqual(["ALL"]);
  });

  it("flattens a nested shiftType tree defensively", () => {
    const card: RequirementCard = {
      uid: "u2",
      shiftType: [["D"]],
      requiredNumPeople: 2,
      weight: -1,
    };
    expect(requirementToForm(card, domain).shiftType).toEqual(["D"]);
  });

  it("round-trips preferredNumPeople as blank when absent", () => {
    const card: RequirementCard = {
      uid: "u3",
      shiftType: ["D"],
      requiredNumPeople: 2,
      weight: -1,
    };
    expect(requirementToForm(card, domain).preferredNumPeople).toBe("");
  });

  it("normalizes an EXPLICIT null qualifiedPeople/date to [ALL] (not [null])", () => {
    const card = {
      uid: "u-null",
      shiftType: ["D"],
      requiredNumPeople: 2,
      weight: -1,
      qualifiedPeople: null,
      date: null,
    } as unknown as RequirementCard;
    const loaded = requirementToForm(card, domain);
    expect(loaded.qualifiedPeople).toEqual(["ALL"]);
    expect(loaded.date).toEqual(["ALL"]);
  });

  it("round-trips an explicit null scope through buildRequirementCard as [ALL]", () => {
    // Load a null-scoped card, then save without changing either scope — the null
    // must NOT survive as `[null]` (M3 / FR-PR-26 / C3 null-as-all).
    const loaded = requirementToForm(
      {
        uid: "u",
        shiftType: ["D"],
        requiredNumPeople: 1,
        weight: -1,
        qualifiedPeople: null,
        date: null,
      } as unknown as RequirementCard,
      domain,
    );
    const rebuilt = buildRequirementCard(loaded, domain, "u");
    expect(rebuilt.qualifiedPeople).toEqual(["ALL"]);
    expect(rebuilt.date).toEqual(["ALL"]);
  });
});

describe("withCardDisabled (M1 Enable/Disable marker)", () => {
  const base: RequirementCard = {
    uid: "u",
    shiftType: ["D"],
    requiredNumPeople: 1,
    weight: -1,
  };

  it("sets the marker and leaves the body untouched when disabling", () => {
    const disabled = withCardDisabled(base, true);
    expect(disabled.disabled).toBe(true);
    expect(disabled.shiftType).toEqual(["D"]);
    expect(disabled.requiredNumPeople).toBe(1);
  });

  it("strips the marker (undefined, not false) when re-enabling", () => {
    const disabled = withCardDisabled(base, true);
    const enabled = withCardDisabled(disabled, false);
    expect(enabled.disabled).toBeUndefined();
    expect("disabled" in enabled).toBe(false);
    expect(enabled.shiftType).toEqual(["D"]);
  });
});

describe("summarizeRefs", () => {
  it("comma-joins scalars, flat arrays, and nested arrays", () => {
    expect(summarizeRefs("D")).toBe("D");
    expect(summarizeRefs(["D", "N"])).toBe("D, N");
    expect(summarizeRefs([["D", "N"]])).toBe("D, N");
  });
});

describe("reorderByDrop (FR-PR-12 — pointer-half DnD)", () => {
  const list = [{ uid: "a" }, { uid: "b" }, { uid: "c" }];

  it('"before" inserts immediately before the target', () => {
    expect(reorderByDrop(list, "a", "c", "before").map((x) => x.uid)).toEqual(["b", "a", "c"]);
  });

  it('"after" inserts immediately after the target', () => {
    expect(reorderByDrop(list, "a", "c", "after").map((x) => x.uid)).toEqual(["b", "c", "a"]);
  });

  it("is a no-op for an unknown uid", () => {
    expect(reorderByDrop(list, "a", "zzz", "after").map((x) => x.uid)).toEqual(["a", "b", "c"]);
  });
});

describe("computeCoverageWarnings (FR-PR-28/40..42)", () => {
  const covState = scenario({
    rangeStart: "2026-01-01",
    rangeEnd: "2026-01-03",
    shifts: [{ id: "D" }, { id: "N" }],
  });

  function req(overrides: Partial<RequirementCard>): RequirementCard {
    return {
      uid: crypto.randomUUID(),
      shiftType: ["D"],
      requiredNumPeople: 1,
      weight: -1,
      ...overrides,
    };
  }

  it("no warnings with no requirements defined and no shifts to check", () => {
    expect(hasCoverageWarnings(computeCoverageWarnings(scenario(), []))).toBe(false);
  });

  it("reports undefined staffing for a shift type with zero requirements", () => {
    const warnings = computeCoverageWarnings(covState, []);
    expect(warnings.undefinedSection?.count).toBe(6); // 2 shift types * 3 dates
    expect(warnings.undefinedSection?.items).toContain("D: ALL");
    expect(warnings.undefinedSection?.items).toContain("N: ALL");
    expect(warnings.duplicateSection).toBeNull();
  });

  it("fully covering one shift type across all dates clears its undefined entry", () => {
    const warnings = computeCoverageWarnings(covState, [req({ shiftType: ["D"], date: ["ALL"] })]);
    expect(warnings.undefinedSection?.items).toEqual(["N: ALL"]);
  });

  it("reports a duplicate when two requirements cover the same (date, shiftType) pair", () => {
    const warnings = computeCoverageWarnings(covState, [
      req({ shiftType: ["D"], date: ["ALL"] }),
      req({ shiftType: ["D"], date: ["ALL"] }),
      req({ shiftType: ["N"], date: ["ALL"] }),
    ]);
    expect(warnings.duplicateSection?.count).toBe(3); // 3 concrete dates duplicated for D
    expect(warnings.duplicateSection?.items[0]).toMatch(/requirements 1 and 2/);
    expect(warnings.undefinedSection).toBeNull();
  });

  it("caps the duplicate example list at 5 with a trailing ellipsis", () => {
    const bigState = scenario({
      rangeStart: "2026-01-01",
      rangeEnd: "2026-01-10",
      shifts: [{ id: "D" }],
    });
    const warnings = computeCoverageWarnings(bigState, [
      req({ shiftType: ["D"], date: ["ALL"] }),
      req({ shiftType: ["D"], date: ["ALL"] }),
    ]);
    expect(warnings.duplicateSection?.items.length).toBe(6);
    expect(warnings.duplicateSection?.items[5]).toBe("...");
  });

  it("excludes a disabled requirement from coverage — it cannot staff anything (M2)", () => {
    const warnings = computeCoverageWarnings(covState, [
      req({ shiftType: ["D"], date: ["ALL"], disabled: true }),
    ]);
    // The disabled requirement does not cover D, so D is still fully undefined.
    expect(warnings.undefinedSection?.items).toContain("D: ALL");
    expect(warnings.duplicateSection).toBeNull();
  });

  it("retains the ORIGINAL 1-based card indices when an earlier card is disabled (M2)", () => {
    const warnings = computeCoverageWarnings(covState, [
      req({ shiftType: ["D"], date: ["ALL"], disabled: true }), // card 1 — skipped
      req({ shiftType: ["D"], date: ["ALL"] }), // card 2
      req({ shiftType: ["D"], date: ["ALL"] }), // card 3
    ]);
    // Duplicate message names cards 2 and 3 (NOT a renumbered "1 and 2").
    expect(warnings.duplicateSection?.items[0]).toMatch(/requirements 2 and 3/);
  });

  it("excludes OFF/LEAVE day states from the coverage domain (M5)", () => {
    const dayStateState = scenario({
      rangeStart: "2026-01-01",
      rangeEnd: "2026-01-02",
      shifts: [{ id: "D" }, { id: "OFF" }, { id: "LEAVE" }],
    });
    const warnings = computeCoverageWarnings(dayStateState, []);
    expect(warnings.undefinedSection?.items).toEqual(["D: ALL"]);
    expect(warnings.undefinedSection?.items).not.toContain("OFF: ALL");
    expect(warnings.undefinedSection?.items).not.toContain("LEAVE: ALL");
  });

  it("returns no coverage warning when only OFF/LEAVE shift types exist (M5)", () => {
    const onlyDayStates = scenario({
      rangeStart: "2026-01-01",
      rangeEnd: "2026-01-02",
      shifts: [{ id: "OFF" }, { id: "LEAVE" }],
    });
    expect(hasCoverageWarnings(computeCoverageWarnings(onlyDayStates, []))).toBe(false);
  });

  it("does not truncate a shift-type id containing a space in duplicate messages (m2)", () => {
    const spaceState = scenario({
      rangeStart: "2026-01-01",
      rangeEnd: "2026-01-01",
      shifts: [{ id: "Long Day" }],
    });
    const warnings = computeCoverageWarnings(spaceState, [
      req({ shiftType: ["Long Day"], date: ["ALL"] }),
      req({ shiftType: ["Long Day"], date: ["ALL"] }),
    ]);
    // The full "Long Day" id survives — the old `date + " " + shiftId` split would
    // have truncated it to "Long".
    const item = warnings.duplicateSection?.items[0] ?? "";
    expect(item).toContain("/ Long Day (");
    expect(item).not.toContain("/ Long (");
    expect(item).toMatch(/requirements 1 and 2/);
  });
});
