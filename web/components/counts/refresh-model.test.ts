import { describe, expect, it } from "vitest";
import { createEmptyScenarioUiState, type ScenarioUiState } from "@/lib/scenario";
import { emptyContractedForm, type ContractedFormState } from "./contracted-model";
import {
  applyContractedRefresh,
  deriveContractedRefresh,
  type RefreshCategory,
} from "./refresh-model";

function scenario(overrides: Partial<ScenarioUiState> = {}): ScenarioUiState {
  return { ...createEmptyScenarioUiState(), ...overrides };
}

function form(overrides: Partial<ContractedFormState> = {}): ContractedFormState {
  return { ...emptyContractedForm(), ...overrides };
}

// D worked 8h → 16 half-hours; E worked 7h30m → 15; F 445min (off-grid) → non-derivable;
// G has no working time → non-derivable. LEAVE always derives to the 16-half-hour credit.
const BASE = scenario({
  staff: [{ id: "Anna" }],
  shifts: [
    { id: "D", durationMinutes: 480 },
    { id: "E", durationMinutes: 450 },
    { id: "F", durationMinutes: 445 },
    { id: "G" },
  ],
});

function categoryOf(rows: ReturnType<typeof deriveContractedRefresh>["rows"], id: string) {
  return rows.find((row) => row.id === id);
}

describe("deriveContractedRefresh — derivation rule", () => {
  it("derives durationMinutes / 30 for a worked shift on the half-hour grid", () => {
    const rows = deriveContractedRefresh(form({ countShiftTypes: ["D", "E"] }), BASE).rows;
    expect(categoryOf(rows, "D")?.derived).toBe(16);
    expect(categoryOf(rows, "E")?.derived).toBe(15);
  });

  it("treats a non-multiple-of-30 duration as non-derivable (never rounds)", () => {
    const rows = deriveContractedRefresh(form({ countShiftTypes: ["F"] }), BASE).rows;
    const row = categoryOf(rows, "F");
    expect(row?.category).toBe("non-derivable");
    expect(row?.derived).toBeNull();
  });

  it("treats a missing durationMinutes as non-derivable", () => {
    const rows = deriveContractedRefresh(form({ countShiftTypes: ["G"] }), BASE).rows;
    const row = categoryOf(rows, "G");
    expect(row?.category).toBe("non-derivable");
    expect(row?.derived).toBeNull();
  });

  it("derives LEAVE to the default paid-leave credit (16 half-hours)", () => {
    const rows = deriveContractedRefresh(form({ countShiftTypes: ["LEAVE"] }), BASE).rows;
    expect(categoryOf(rows, "LEAVE")?.derived).toBe(16);
  });
});

describe("deriveContractedRefresh — preview categorization", () => {
  it("categorizes a blank/absent id with a derivable value as added", () => {
    const rows = deriveContractedRefresh(form({ countShiftTypes: ["D"] }), BASE).rows;
    expect(categoryOf(rows, "D")?.category).toBe("added");
  });

  it("categorizes a present value that differs as changed", () => {
    const rows = deriveContractedRefresh(
      form({ countShiftTypes: ["D"], countShiftTypeCoefficients: [["D", 10]] }),
      BASE,
    ).rows;
    expect(categoryOf(rows, "D")?.category).toBe("changed");
  });

  it("categorizes a present value equal to the derived value as unchanged", () => {
    const rows = deriveContractedRefresh(
      form({ countShiftTypes: ["D"], countShiftTypeCoefficients: [["D", 16]] }),
      BASE,
    ).rows;
    expect(categoryOf(rows, "D")?.category).toBe("unchanged");
  });

  it("categorizes a worked id without valid working time as non-derivable and keeps its value", () => {
    const rows = deriveContractedRefresh(
      form({ countShiftTypes: ["F"], countShiftTypeCoefficients: [["F", 12]] }),
      BASE,
    ).rows;
    const row = categoryOf(rows, "F");
    expect(row?.category).toBe("non-derivable");
    expect(row?.current).toBe(12);
  });

  it("categorizes a stored pair outside the concrete set as removed", () => {
    const rows = deriveContractedRefresh(
      form({
        countShiftTypes: ["D"],
        countShiftTypeCoefficients: [
          ["D", 16],
          ["N", 4],
        ],
      }),
      BASE,
    ).rows;
    expect(categoryOf(rows, "N")?.category).toBe("removed");
  });

  it("never runs implicitly — it is a pure function returning a preview only", () => {
    const draft = form({ countShiftTypes: ["D"] });
    const snapshot = structuredClone(draft);
    deriveContractedRefresh(draft, BASE);
    // The input draft is untouched: derivation only PREVIEWS, it does not mutate.
    expect(draft).toEqual(snapshot);
  });
});

describe("applyContractedRefresh — Confirm applies to the draft", () => {
  it("sets added and changed ids to their derived values", () => {
    const draft = form({
      countShiftTypes: ["D", "E"],
      countShiftTypeCoefficients: [
        ["D", ""],
        ["E", 10],
      ],
    });
    const next = applyContractedRefresh(draft, deriveContractedRefresh(draft, BASE));
    expect(next.countShiftTypeCoefficients).toEqual([
      ["D", 16],
      ["E", 15],
    ]);
  });

  it("keeps a non-derivable id's existing manual value and never rounds it", () => {
    const draft = form({
      countShiftTypes: ["D", "F"],
      countShiftTypeCoefficients: [
        ["D", ""],
        ["F", 12],
      ],
    });
    const next = applyContractedRefresh(draft, deriveContractedRefresh(draft, BASE));
    expect(next.countShiftTypeCoefficients).toEqual([
      ["D", 16],
      // F (445 min) is kept verbatim — NOT rounded to 14/15.
      ["F", 12],
    ]);
  });

  it("leaves unchanged ids as-is", () => {
    const draft = form({
      countShiftTypes: ["D"],
      countShiftTypeCoefficients: [["D", 16]],
    });
    const next = applyContractedRefresh(draft, deriveContractedRefresh(draft, BASE));
    expect(next.countShiftTypeCoefficients).toEqual([["D", 16]]);
  });

  it("drops a removed id", () => {
    const draft = form({
      countShiftTypes: ["D"],
      countShiftTypeCoefficients: [
        ["D", ""],
        ["N", 4],
      ],
    });
    const next = applyContractedRefresh(draft, deriveContractedRefresh(draft, BASE));
    expect(next.countShiftTypeCoefficients).toEqual([["D", 16]]);
  });

  it("derives LEAVE and preserves every non-coefficient draft field", () => {
    const draft = form({
      description: "Monthly contract",
      person: ["Anna"],
      countDates: ["ALL"],
      countShiftTypes: ["D", "LEAVE"],
      targetExact: "160h",
    });
    const next = applyContractedRefresh(draft, deriveContractedRefresh(draft, BASE));
    expect(next.countShiftTypeCoefficients).toEqual([
      ["D", 16],
      ["LEAVE", 16],
    ]);
    expect(next.description).toBe("Monthly contract");
    expect(next.person).toEqual(["Anna"]);
    expect(next.targetExact).toBe("160h");
  });

  it("produces exactly the concrete id set, matching a selector re-sync", () => {
    const draft = form({ countShiftTypes: ["D", "E", "F"] });
    const next = applyContractedRefresh(draft, deriveContractedRefresh(draft, BASE));
    const ids = next.countShiftTypeCoefficients.map(([id]) => id);
    expect(ids).toEqual(["D", "E", "F"]);
  });
});

describe("applyContractedRefresh — applies against the LIVE draft (P1 regression)", () => {
  it("keeps a non-derivable value edited AFTER the preview, not the stale snapshot", () => {
    // Preview computed while F = 12 (non-derivable, "kept").
    const previewed = form({
      countShiftTypes: ["D", "F"],
      countShiftTypeCoefficients: [
        ["D", ""],
        ["F", 12],
      ],
    });
    const preview = deriveContractedRefresh(previewed, BASE);
    // The author then edits F to 13 before Confirm; apply must honor the live 13.
    const edited = form({
      countShiftTypes: ["D", "F"],
      countShiftTypeCoefficients: [
        ["D", ""],
        ["F", 13],
      ],
    });
    const next = applyContractedRefresh(edited, preview);
    expect(next.countShiftTypeCoefficients).toEqual([
      ["D", 16],
      ["F", 13],
    ]);
  });

  it("keeps an unchanged id edited after the preview rather than reverting it", () => {
    const previewed = form({
      countShiftTypes: ["D"],
      countShiftTypeCoefficients: [["D", 16]], // equals derived → "unchanged"
    });
    const preview = deriveContractedRefresh(previewed, BASE);
    const edited = form({
      countShiftTypes: ["D"],
      countShiftTypeCoefficients: [["D", 20]], // author overrode after preview
    });
    // D was "unchanged" in the snapshot, so apply keeps the live value (20), not 16.
    expect(applyContractedRefresh(edited, preview).countShiftTypeCoefficients).toEqual([["D", 20]]);
  });
});

describe("deriveContractedRefresh — unresolved selectors (P1 recovery path)", () => {
  it("surfaces a selected string selector that does not resolve, without applying it", () => {
    const draft = form({ countShiftTypes: ["D", "ZZZ"] });
    const preview = deriveContractedRefresh(draft, BASE);
    expect(preview.unresolved).toEqual(["ZZZ"]);
    // The unresolved selector is informational only — apply produces just the
    // concrete id (D), never a fabricated coefficient for the unknown selector.
    const next = applyContractedRefresh(draft, preview);
    expect(next.countShiftTypeCoefficients).toEqual([["D", 16]]);
  });

  it("reports no unresolved selectors for a fully-resolvable selection", () => {
    expect(
      deriveContractedRefresh(form({ countShiftTypes: ["D", "LEAVE"] }), BASE).unresolved,
    ).toEqual([]);
  });
});

// A compile-time reminder that every category the derivation can emit has apply
// semantics covered above (added/changed → derived, others → kept/dropped).
const _ALL: RefreshCategory[] = ["added", "changed", "unchanged", "non-derivable", "removed"];
void _ALL;
