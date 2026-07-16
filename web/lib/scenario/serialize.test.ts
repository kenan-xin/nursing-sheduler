import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { serializeScenario, validateScenario, ScenarioValidationError } from "./serialize";
import { toCanonicalScenarioDocument } from "./canonical";
import { makeValidUiState } from "./test-fixtures";
import type { ScenarioUiState } from "./types";

describe("serializeScenario (F2 boundary)", () => {
  it("dumps a valid UI state to backend-shaped YAML 1.2", () => {
    const yaml = serializeScenario(makeValidUiState());
    const parsed = parse(yaml);

    expect(parsed.apiVersion).toBe("alpha");
    // Canonical `type` strings present.
    expect(parsed.preferences[0].type).toBe("at most one shift per day");
    // Explicit ALL survived (not stripped).
    const requirement = parsed.preferences.find(
      (p: { type: string }) => p.type === "shift type requirement",
    );
    expect(requirement.qualifiedPeople).toBe("ALL");
    expect(requirement.date).toBe("ALL");
  });

  it("emits a LEAVE cell as a hard `.inf` shift request and omits zero rest", () => {
    const yaml = serializeScenario(makeValidUiState());
    // LEAVE pin serializes with `.inf` weight (YAML 1.2 form the ruamel loader reads).
    expect(yaml).toContain(".inf");
    const parsed = parse(yaml);
    const leave = parsed.preferences.find(
      (p: { type: string; shiftType?: string }) =>
        p.type === "shift request" && p.shiftType === "LEAVE",
    );
    expect(leave.weight).toBe(Infinity);
    // restMinutes:0 is never persisted; only the paired clock/duration remain.
    const day = parsed.shiftTypes.items.find((s: { id: string }) => s.id === "D");
    expect(day.restMinutes).toBe(60);
    expect("restMinutes" in parsed.shiftTypes.items[1]).toBe(false);
  });

  it("throws ScenarioValidationError with issues for an invalid document", () => {
    const state: ScenarioUiState = makeValidUiState();
    // Equal start/end shift — review finding #6.
    state.shifts[1] = { id: "E", startTime: "09:00", endTime: "09:00" };
    expect(() => serializeScenario(state)).toThrow(ScenarioValidationError);
    try {
      serializeScenario(state);
    } catch (error) {
      const issues = (error as ScenarioValidationError).issues;
      expect(issues.some((i) => /must differ/.test(i.message))).toBe(true);
    }
  });
});

describe("validateScenario (canonical document, not UI state)", () => {
  it("accepts the projected canonical document", () => {
    const doc = toCanonicalScenarioDocument(makeValidUiState());
    expect(validateScenario(doc).ok).toBe(true);
  });
});

describe("canonicalization is applied before dump (not just validated)", () => {
  it("omits an explicit restMinutes:0 and makes implicit requirement scopes explicit ALL", () => {
    const state: ScenarioUiState = makeValidUiState();
    // Start from an explicit zero rest and omitted all-scopes (not already-absent).
    state.shifts[0] = {
      id: "D",
      startTime: "09:00",
      endTime: "17:00",
      restMinutes: 0,
      durationMinutes: 480,
    };
    state.cardsByKind.requirements = [
      { uid: "r", shiftType: "D", requiredNumPeople: 1, weight: -1 },
    ];

    const yaml = serializeScenario(state);
    expect(yaml).not.toMatch(/restMinutes/);
    const parsed = parse(yaml);
    const requirement = parsed.preferences.find(
      (p: { type: string }) => p.type === "shift type requirement",
    );
    expect(requirement.qualifiedPeople).toBe("ALL");
    expect(requirement.date).toBe("ALL");
    const day = parsed.shiftTypes.items.find((s: { id: string }) => s.id === "D");
    expect("restMinutes" in day).toBe(false);
  });
});
