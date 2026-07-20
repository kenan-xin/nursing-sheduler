import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { toCanonicalScenarioDocument } from "./canonical";
import {
  prepareOptimizeSubmission,
  validatePeopleReverseMap,
  type PeopleReverseMap,
} from "./prepare-optimize-submission";
import { serializeCanonicalDocument } from "./serialize";
import { makeValidUiState } from "./test-fixtures";
import type { CanonicalScenarioDocument, ScenarioUiState } from "./types";

function docFrom(state: ScenarioUiState): CanonicalScenarioDocument {
  return toCanonicalScenarioDocument(state);
}

/** Build a lookup from the ordered `[anon, original]` tuples. */
function reverseLookup(map: PeopleReverseMap): Map<string, string | number> {
  return new Map(map.map(([anon, original]) => [anon, original]));
}

/** A producer-invalid draft (equal start/end shift — mirrors T05's fixture trick). */
function makeInvalidUiState(): ScenarioUiState {
  const state = makeValidUiState();
  state.shifts[1] = { id: "E", startTime: "09:00", endTime: "09:00" };
  return state;
}

describe("prepareOptimizeSubmission — plain path", () => {
  it("produces byte-identical strict YAML to serializeCanonicalDocument, no reverse map", () => {
    const document = docFrom(makeValidUiState());
    const result = prepareOptimizeSubmission(document, { anonymize: false });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prep.yaml).toBe(serializeCanonicalDocument(document));
    expect(result.prep.anonymized).toBe(false);
    expect(result.prep.reverseMap).toEqual([]);
    expect(result.prep.peopleCount).toBe(document.people.items.length);
  });

  it("preserves descriptions on the plain path", () => {
    const state = makeValidUiState();
    state.meta.description = "PRIVATE-NOTE top level";
    const document = docFrom(state);
    const result = prepareOptimizeSubmission(document, { anonymize: false });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prep.yaml).toContain("PRIVATE-NOTE top level");
  });

  it("blocks an invalid draft with the producer issues", () => {
    const document = docFrom(makeInvalidUiState());
    const result = prepareOptimizeSubmission(document, { anonymize: false });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.length).toBeGreaterThan(0);
  });
});

describe("prepareOptimizeSubmission — anonymized path (fixed people-only toggle)", () => {
  it("rewrites people ids to P# and leaves group ids untouched", () => {
    const document = docFrom(makeValidUiState());
    const result = prepareOptimizeSubmission(document, { anonymize: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prep.anonymized).toBe(true);
    // People replaced, real names gone; groups (G ids) untouched.
    expect(result.prep.yaml).not.toContain("Alice");
    expect(result.prep.yaml).toContain("Seniors");
    expect(result.prep.yaml).toContain("P1");
  });

  it("recursively removes every nested description from the anonymized YAML", () => {
    const state = makeValidUiState();
    state.meta.description = "PRIVATE-NOTE scenario";
    state.staff = [{ id: "Alice", description: "PRIVATE-NOTE person" }, { id: "Bob" }];
    state.staffGroups = [
      { id: "Seniors", members: ["Alice", "Bob"], description: "PRIVATE-NOTE group" },
    ];
    state.reqData = [
      {
        uid: "c",
        kind: "request",
        person: "Alice",
        date: "2026-05-15",
        shiftType: "D",
        weight: 1,
        description: "PRIVATE-NOTE preference",
      },
    ];
    const document = docFrom(state);
    const before = structuredClone(document);

    const result = prepareOptimizeSubmission(document, { anonymize: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // No description prose anywhere in the submitted bytes.
    expect(result.prep.yaml).not.toContain("PRIVATE-NOTE");
    expect(result.prep.yaml).not.toMatch(/(^|\n)\s*description:/);
    // The source document is untouched (descriptions still present).
    expect(document).toEqual(before);
  });

  it("co-derives the reverse map and YAML from the SAME transformed document", () => {
    const document = docFrom(makeValidUiState());
    const result = prepareOptimizeSubmission(document, { anonymize: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const lookup = reverseLookup(result.prep.reverseMap);
    const parsed = parse(result.prep.yaml) as { people: { items: { id: string }[] } };
    const originalIds = new Set(document.people.items.map((p) => String(p.id)));
    for (const item of parsed.people.items) {
      expect(lookup.has(item.id)).toBe(true);
      expect(originalIds.has(String(lookup.get(item.id)))).toBe(true);
    }
    // One ordered tuple per person, in people-item order.
    expect(result.prep.reverseMap.map(([anon]) => anon)).toEqual(["P1", "P2"]);
    expect(result.prep.reverseMap.map(([, original]) => original)).toEqual(["Alice", "Bob"]);
    expect(result.prep.peopleCount).toBe(document.people.items.length);
  });

  it("preserves Unicode original ids exactly in the reverse map", () => {
    const state = makeValidUiState();
    state.staff = [{ id: "Zoë 张三" }, { id: "Bøb" }];
    state.staffGroups = [{ id: "Seniors", members: ["Zoë 张三", "Bøb"] }];
    state.reqData = [];
    state.exportLayout.formatting = [];
    const document = docFrom(state);

    const result = prepareOptimizeSubmission(document, { anonymize: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.prep.reverseMap.map(([, original]) => original).sort()).toEqual([
      "Bøb",
      "Zoë 张三",
    ]);
    expect(result.prep.yaml).not.toContain("Zoë");
    expect(result.prep.yaml).not.toContain("Bøb");
  });

  it("preserves a numeric (typed) original id as a number, not a string", () => {
    const state = makeValidUiState();
    state.staff = [{ id: 7 as unknown as string }, { id: 42 as unknown as string }];
    state.staffGroups = [];
    state.reqData = [];
    state.exportLayout.formatting = [];
    const document = docFrom(state);

    const result = prepareOptimizeSubmission(document, { anonymize: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const lookup = reverseLookup(result.prep.reverseMap);
    expect(lookup.get("P1")).toBe(7);
    expect(lookup.get("P2")).toBe(42);
    for (const [, original] of result.prep.reverseMap) expect(typeof original).toBe("number");
  });

  it("blocks an invalid draft before any transform is attempted", () => {
    const document = docFrom(makeInvalidUiState());
    const result = prepareOptimizeSubmission(document, { anonymize: true });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("does not mutate the input document", () => {
    const document = docFrom(makeValidUiState());
    const before = structuredClone(document);
    prepareOptimizeSubmission(document, { anonymize: true });
    expect(document).toEqual(before);
  });
});

describe("validatePeopleReverseMap — strict tuple transport", () => {
  it("accepts a well-formed ordered tuple map of the expected size", () => {
    const map = validatePeopleReverseMap(
      [
        ["P1", "Alice"],
        ["P2", 42],
      ],
      2,
    );
    expect(map).toEqual([
      ["P1", "Alice"],
      ["P2", 42],
    ]);
  });

  it("keeps numeric 1 and string '1' as distinct typed originals", () => {
    const map = validatePeopleReverseMap(
      [
        ["P1", 1],
        ["P2", "1"],
      ],
      2,
    );
    expect(map).not.toBeNull();
  });

  it.each([
    ["a wrong cardinality", [["P1", "Alice"]], 2],
    ["a non-array entry", [{ 0: "P1", 1: "Alice" }], 1],
    ["a malformed anonymized id", [["X1", "Alice"]], 1],
    ["a leading-zero anonymized id", [["P01", "Alice"]], 1],
    [
      "a duplicate anonymized id",
      [
        ["P1", "Alice"],
        ["P1", "Bob"],
      ],
      2,
    ],
    ["a fractional numeric original", [["P1", 1.5]], 1],
    ["an infinite numeric original", [["P1", Number.POSITIVE_INFINITY]], 1],
    [
      "a duplicate typed original",
      [
        ["P1", "Alice"],
        ["P2", "Alice"],
      ],
      2,
    ],
    ["a non-id original (object)", [["P1", { evil: true }]], 1],
  ])("rejects %s", (_label, value, count) => {
    expect(validatePeopleReverseMap(value, count)).toBeNull();
  });
});
