import { describe, expect, it } from "vitest";
// Import the whole public surface through the barrel exactly as T04/T05 will.
import {
  canonicalHash,
  canonicalStringify,
  createEmptyScenarioUiState,
  LEAVE_PIN_WEIGHT,
  PREFERENCE_TYPE,
  toCanonicalScenarioDocument,
  type AffinityCardBody,
  type CanonicalExportExtraColumn,
  type CanonicalExportExtraRow,
  type CanonicalExportFormattingRule,
  type CanonicalScenarioDocument,
  type CountCard,
  type CountCardBody,
  type CoveringCardBody,
  type ImportNormalizationTarget,
  type RequirementCardBody,
  type ScenarioUiState,
  type SuccessionCardBody,
  type UiRequestCell,
} from "@/lib/scenario";

// ---------------------------------------------------------------------------
// Compile-time surface coverage. These `satisfies` fixtures are checked by
// `tsc --noEmit` (test files are in the tsconfig `include`), so they are the
// proof that every exported variant is consumable unchanged — not just the
// barrel imports. The `@ts-expect-error` cases fail to compile if the contract
// regresses to the pre-review shapes.
// ---------------------------------------------------------------------------

const requirementBody = {
  shiftType: "LD",
  requiredNumPeople: 1,
  qualifiedPeople: "Seniors",
  weight: -1,
} satisfies RequirementCardBody;

const successionBody = {
  person: "ALL",
  pattern: [["N"], ["AM1"]],
  weight: -1,
} satisfies SuccessionCardBody;

const ordinaryCountBody = {
  person: "ALL",
  countDates: "2026-02-01~2026-02-07",
  countShiftTypes: "OFF",
  expression: "x >= T",
  target: 2,
  weight: Infinity,
} satisfies CountCardBody;

const contractedCountBody = {
  person: "ALL",
  countDates: "ALL",
  countShiftTypes: ["AM1", "LD", "LEAVE"],
  countShiftTypeCoefficients: [
    ["AM1", 16],
    ["LD", 25],
    ["LEAVE", 16],
  ],
  expression: "x = T",
  target: 320,
  weight: Infinity,
  tag: "contracted_hours",
  policy: "exact",
} satisfies CountCardBody;

// MAJOR 1 — a contracted-hours marker without `policy` must not type-check
// (it would otherwise be silently downgraded to an ordinary count on projection).
// @ts-expect-error contracted variant requires `policy` alongside `tag`
const partialContractedBody: CountCardBody = {
  person: "ALL",
  countDates: "ALL",
  countShiftTypes: ["AM1"],
  expression: "x = T",
  target: 320,
  weight: Infinity,
  tag: "contracted_hours",
};

const affinityBody = {
  date: "ALL",
  people1: [0],
  people2: [1],
  shiftTypes: [["AM1"]],
  weight: 1,
} satisfies AffinityCardBody;

const coveringBody = {
  preceptors: [1],
  preceptees: [0],
  shiftTypes: [["LD"]],
  weight: 1,
} satisfies CoveringCardBody;

// All four export formatting-rule union members + both extras.
const personRule = { type: "row", people: [0, "Seniors"] } satisfies CanonicalExportFormattingRule;
const dateRule = {
  type: "date header",
  dates: [1, "week1"],
} satisfies CanonicalExportFormattingRule;
const historyHeaderRule = {
  type: "history header",
  backgroundColor: "#fefce8",
} satisfies CanonicalExportFormattingRule;
// MAJOR 4 — numeric shift ids are backend-valid in export selectors.
const cellRule = {
  type: "cell",
  people: [0],
  dates: [10],
  shiftTypes: [1, "AM1"],
  when: { preference: { types: ["shift request"], satisfied: true } },
} satisfies CanonicalExportFormattingRule;
const extraColumn = {
  type: "count",
  header: "AM count",
  countShiftTypes: [1, "AM1"],
  countDates: [10],
} satisfies CanonicalExportExtraColumn;
const extraRow = {
  type: "count",
  header: "LD row",
  countShiftTypes: [2, "LD"],
  countPeople: [0, "Seniors"],
} satisfies CanonicalExportExtraRow;

// MAJOR 4 — preference selectors, by contrast, are strings only.
const numericPreferenceSelector: RequirementCardBody = {
  // @ts-expect-error preference `shiftType` does not accept a bare number
  shiftType: 1,
  requiredNumPeople: 1,
  weight: -1,
};

// All three request-cell union members (MAJOR 3 — one authority via `kind`).
const requestCells = [
  { person: 0, date: 10, kind: "leave" },
  { person: 1, date: 12, kind: "off", weight: 1 },
  { person: 1, date: 13, kind: "request", shiftType: "AM1", weight: -2 },
] satisfies UiRequestCell[];

// MAJOR 2 — a NON-EMPTY import target built with no store `uid`s at all.
const importTarget = {
  meta: { apiVersion: "alpha" },
  rangeStart: "2026-02-01",
  rangeEnd: "2026-02-28",
  staff: [{ id: 0, description: "Nurse 0" }],
  staffGroups: [{ id: "Seniors", members: [0] }],
  shifts: [{ id: "AM1", durationMinutes: 420 }],
  shiftGroups: [],
  dateGroups: [],
  cardsByKind: {
    requirements: [requirementBody],
    successions: [successionBody],
    counts: [ordinaryCountBody, contractedCountBody],
    affinities: [affinityBody],
    coverings: [coveringBody],
  },
  reqData: requestCells,
  exportLayout: {
    formatting: [personRule, dateRule, historyHeaderRule, cellRule],
    extraColumns: [extraColumn],
    extraRows: [extraRow],
  },
} satisfies ImportNormalizationTarget;

// T04's job: hydrate the keyless bodies into store-keyed cards.
let uidSeq = 0;
function nextUid(): string {
  return `k${uidSeq++}`;
}
function hydrate(target: ImportNormalizationTarget): ScenarioUiState {
  return {
    ...target,
    guidedRulePins: [],
    cardsByKind: {
      requirements: target.cardsByKind.requirements.map((b) => ({ ...b, uid: nextUid() })),
      successions: target.cardsByKind.successions.map((b) => ({ ...b, uid: nextUid() })),
      counts: target.cardsByKind.counts.map((b): CountCard => ({ ...b, uid: nextUid() })),
      affinities: target.cardsByKind.affinities.map((b) => ({ ...b, uid: nextUid() })),
      coverings: target.cardsByKind.coverings.map((b) => ({ ...b, uid: nextUid() })),
    },
  };
}

// --- T04-shaped consumer stub ----------------------------------------------
class StoreStub {
  state: ScenarioUiState = createEmptyScenarioUiState();
  baseline = "";

  fingerprint(): string {
    return canonicalHash(toCanonicalScenarioDocument(this.state));
  }

  markSaved(): void {
    this.baseline = this.fingerprint();
  }

  get isDirty(): boolean {
    return this.fingerprint() !== this.baseline;
  }
}

describe("shared contract surface", () => {
  it("T04-shaped store consumes the projection + hash for dirty tracking", () => {
    const store = new StoreStub();
    store.markSaved();
    expect(store.isDirty).toBe(false);

    store.state.staff = [{ id: 7, description: "Nurse 7" }];
    expect(store.isDirty).toBe(true);

    store.markSaved();
    expect(store.isDirty).toBe(false);
  });

  it("T05-shaped path: keyless import target → hydrate → canonical doc with every preference kind", () => {
    const doc: CanonicalScenarioDocument = toCanonicalScenarioDocument(hydrate(importTarget));
    const kinds = new Set(doc.preferences.map((p) => p.type));
    expect(kinds).toEqual(
      new Set([
        PREFERENCE_TYPE.maxOneShiftPerDay,
        PREFERENCE_TYPE.shiftTypeRequirement,
        PREFERENCE_TYPE.shiftTypeSuccessions,
        PREFERENCE_TYPE.shiftCount,
        PREFERENCE_TYPE.shiftAffinity,
        PREFERENCE_TYPE.shiftTypeCovering,
        PREFERENCE_TYPE.shiftRequest,
      ]),
    );
    // The contracted-hours count carried its marker through to hoursContract.
    const contracted = doc.preferences.find(
      (p) => p.type === PREFERENCE_TYPE.shiftCount && p.hoursContract !== undefined,
    );
    expect(contracted).toMatchObject({ hoursContract: { unit: "half-hour", policy: "exact" } });
    // Numeric export shift ids survived the projection.
    expect(doc.export?.extraColumns?.[0].countShiftTypes).toEqual([1, "AM1"]);
    // A leave cell serialized with the centralized hard weight, not an authored one.
    const leave = doc.preferences.find(
      (p) => p.type === PREFERENCE_TYPE.shiftRequest && p.shiftType === "LEAVE",
    );
    expect(leave).toMatchObject({ weight: LEAVE_PIN_WEIGHT });
  });

  it("exposes canonicalStringify for downstream stable serialization", () => {
    expect(typeof canonicalStringify({ b: 1, a: 2 })).toBe("string");
  });

  it("ScenarioUiState is a keyed refinement of the keyless import target", () => {
    // Compile-time proof of the boundary direction: keyed durable state is a
    // valid import target (bodies are a structural subset)...
    const state = createEmptyScenarioUiState();
    const asTarget: ImportNormalizationTarget = state;
    expect(asTarget.reqData).toEqual([]);
    // ...and only a hydrated (uid-assigned) target becomes valid durable state.
    const hydrated: ScenarioUiState = hydrate(importTarget);
    expect(hydrated.cardsByKind.requirements[0].uid).toBeTypeOf("string");
  });

  it("rejects the pre-review shapes at compile time (@ts-expect-error fixtures)", () => {
    // These consts only compile because a directive suppresses the type error;
    // referencing them keeps the fixtures live (and lint-clean).
    expect(partialContractedBody.tag).toBe("contracted_hours");
    expect(numericPreferenceSelector.requiredNumPeople).toBe(1);
  });
});
