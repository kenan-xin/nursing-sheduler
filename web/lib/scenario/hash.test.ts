import { describe, expect, it } from "vitest";
import { canonicalHash, canonicalStringify } from "@/lib/scenario/hash";
import { toCanonicalScenarioDocument } from "@/lib/scenario/canonical";
import type { CanonicalScenarioDocument, ScenarioUiState } from "@/lib/scenario/types";

function baseDoc(): CanonicalScenarioDocument {
  return {
    apiVersion: "alpha",
    description: "ward",
    dates: { range: { startDate: "2026-02-01", endDate: "2026-02-28" } },
    people: { items: [{ id: 0, description: "Nurse 0" }] },
    shiftTypes: { items: [{ id: "AM1", durationMinutes: 420 }] },
    preferences: [
      { type: "at most one shift per day" },
      { type: "shift request", person: 0, date: 10, shiftType: "LEAVE", weight: Infinity },
    ],
  };
}

describe("canonicalStringify", () => {
  it("is independent of object key insertion order", () => {
    const a = canonicalStringify({ b: 1, a: 2, c: { y: 1, x: 2 } });
    const b = canonicalStringify({ a: 2, c: { x: 2, y: 1 }, b: 1 });
    expect(a).toBe(b);
  });

  it("drops undefined object properties but nulls undefined array holes", () => {
    expect(canonicalStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalStringify([1, undefined, 2])).toBe("[1,null,2]");
  });

  it("preserves non-finite numbers that JSON would flatten to null", () => {
    expect(canonicalStringify(Infinity)).not.toBe(canonicalStringify(-Infinity));
    expect(canonicalStringify(Infinity)).not.toBe(canonicalStringify(null));
    expect(canonicalStringify(NaN)).not.toBe(canonicalStringify(null));
  });

  it("does not alias a non-finite number with a look-alike literal string", () => {
    // The bareword `@Infinity` cannot be produced by a (quoted) string, so a
    // numeric Infinity never canonicalizes the same as the literal "@Infinity".
    expect(canonicalStringify(Infinity)).not.toBe(canonicalStringify("@Infinity"));
    expect(canonicalStringify(-Infinity)).not.toBe(canonicalStringify("@-Infinity"));
    expect(canonicalStringify(NaN)).not.toBe(canonicalStringify("@NaN"));
    // The literal string keeps its JSON quotes.
    expect(canonicalStringify("@Infinity")).toBe('"@Infinity"');
  });
});

describe("canonicalHash", () => {
  it("is order-independent: same doc, keys in different order ⇒ identical hash", () => {
    const doc = baseDoc();
    const reordered: CanonicalScenarioDocument = {
      shiftTypes: { items: [{ durationMinutes: 420, id: "AM1" }] },
      people: { items: [{ description: "Nurse 0", id: 0 }] },
      preferences: [
        { type: "at most one shift per day" },
        { weight: Infinity, shiftType: "LEAVE", date: 10, person: 0, type: "shift request" },
      ],
      dates: { range: { endDate: "2026-02-28", startDate: "2026-02-01" } },
      description: "ward",
      apiVersion: "alpha",
    };
    expect(canonicalHash(reordered)).toBe(canonicalHash(doc));
  });

  it("changes when a single field changes", () => {
    const doc = baseDoc();
    const changed = baseDoc();
    changed.people.items[0].description = "Nurse Zero";
    expect(canonicalHash(changed)).not.toBe(canonicalHash(doc));
  });

  it("distinguishes a hard weight from a soft one", () => {
    const soft = baseDoc();
    (soft.preferences[1] as { weight: number }).weight = 1;
    expect(canonicalHash(soft)).not.toBe(canonicalHash(baseDoc()));
  });

  it("distinguishes a numeric-Infinity id from the literal string tag", () => {
    const numeric = baseDoc();
    numeric.people.items[0].id = Infinity;
    const literal = baseDoc();
    literal.people.items[0].id = "@Infinity";
    expect(canonicalHash(numeric)).not.toBe(canonicalHash(literal));
  });

  it("is a stable 32-char lowercase hex string across runs", () => {
    const first = canonicalHash(baseDoc());
    const second = canonicalHash(baseDoc());
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
  });

  it("tracks the projection: an F2-only edit does not change the hash", () => {
    const state: ScenarioUiState = {
      meta: { apiVersion: "alpha" },
      rangeStart: "2026-02-01",
      rangeEnd: "2026-02-28",
      staff: [{ _k: "p0", id: 0 }],
      staffGroups: [],
      shifts: [],
      shiftGroups: [],
      dateGroups: [],
      cardsByKind: { requirements: [], successions: [], counts: [], affinities: [], coverings: [] },
      reqData: [],
      exportLayout: { formatting: [], extraColumns: [], extraRows: [] },
    };
    const before = canonicalHash(toCanonicalScenarioDocument(state));
    // Change only a React key — an F2-only field the projection strips.
    state.staff[0]._k = "p0-renamed";
    const after = canonicalHash(toCanonicalScenarioDocument(state));
    expect(after).toBe(before);
  });
});
