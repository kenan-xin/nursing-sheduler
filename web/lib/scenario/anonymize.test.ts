import { describe, expect, it } from "vitest";
import { buildIdMap, anonymizeDocument } from "./anonymize";
import { toCanonicalScenarioDocument } from "./canonical";
import { validateScenario } from "./serialize";
import { makeValidUiState } from "./test-fixtures";

describe("buildIdMap", () => {
  it("assigns collision-safe P#/G# in definition order", () => {
    const doc = toCanonicalScenarioDocument(makeValidUiState());
    const idMap = buildIdMap(doc);
    expect(idMap.people.get("Alice")).toBe("P1");
    expect(idMap.people.get("Bob")).toBe("P2");
    expect(idMap.groups.get("Seniors")).toBe("G1");
    // reverse is the exact inverse.
    expect(idMap.reverse.get("P1")).toBe("Alice");
    expect(idMap.reverse.get("G1")).toBe("Seniors");
  });

  it("skips a generated id that collides with a retained original id", () => {
    const doc = toCanonicalScenarioDocument(makeValidUiState());
    // A person literally named "P1" must not be aliased onto another person's id.
    doc.people.items = [{ id: "P1" }, { id: "Alice" }];
    const idMap = buildIdMap(doc);
    const targets = [...idMap.people.values()];
    expect(new Set(targets).size).toBe(targets.length); // bijective
    expect(targets).not.toContain("P1"); // the retained "P1" is skipped
  });
});

describe("anonymizeDocument", () => {
  it("rewrites people refs everywhere and preserves reserved keywords", () => {
    const original = toCanonicalScenarioDocument(makeValidUiState());
    const snapshot = structuredClone(original);
    const idMap = buildIdMap(original);
    const anon = anonymizeDocument(original, idMap);

    // Live document is untouched (copy-not-mutate).
    expect(original).toEqual(snapshot);

    // People + group ids rewritten.
    expect(anon.people.items.map((p) => p.id)).toEqual(["P1", "P2"]);
    expect(anon.people.groups?.[0].id).toBe("G1");
    expect(anon.people.groups?.[0].members).toEqual(["P1", "P2"]);

    // Requirement's `qualifiedPeople: ALL` reserved keyword preserved.
    const requirement = anon.preferences.find((p) => p.type === "shift type requirement");
    expect(requirement && "qualifiedPeople" in requirement && requirement.qualifiedPeople).toBe(
      "ALL",
    );

    // Shift request person rewritten.
    const request = anon.preferences.find(
      (p) => p.type === "shift request" && "shiftType" in p && p.shiftType === "D",
    );
    expect(request && "person" in request && request.person).toBe("P2");

    // Export row people rewritten.
    const rule = anon.export?.formatting?.[0];
    expect(rule && rule.type === "row" && rule.people).toEqual(["P1"]);

    // Shift-type ids are NOT anonymized.
    expect(anon.shiftTypes.items.map((s) => s.id)).toEqual(["D", "E", "N"]);
  });

  it("produces a still-valid document that round-trips through producer validation", () => {
    const original = toCanonicalScenarioDocument(makeValidUiState());
    const anon = anonymizeDocument(original, buildIdMap(original));
    expect(validateScenario(anon).ok).toBe(true);
  });

  it("anonymizes a backend-valid person literally named OFF (does not leak it)", () => {
    const original = toCanonicalScenarioDocument(makeValidUiState());
    original.people.items = [{ id: "OFF" }, { id: "LEAVE" }];
    original.people.groups = [{ id: "Seniors", members: ["OFF", "LEAVE"] }];
    const idMap = buildIdMap(original);
    const anon = anonymizeDocument(original, idMap);
    expect(anon.people.items.map((p) => p.id)).toEqual(["P1", "P2"]);
    expect(anon.people.groups?.[0].members).toEqual(["P1", "P2"]);
    // No original people-domain id survives in the anonymized document.
    expect(anon.people.items.some((p) => p.id === "OFF" || p.id === "LEAVE")).toBe(false);
  });
});
