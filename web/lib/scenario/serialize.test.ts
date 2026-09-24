import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { serializeScenario, validateScenario, ScenarioValidationError } from "./serialize";
import { toCanonicalScenarioDocument } from "./canonical";
import { importScenarioYaml } from "./import-scenario";
import { makeValidUiState } from "./test-fixtures";
import type { ScenarioUiState } from "./types";

const APP_VERSION_ENV = "NEXT_PUBLIC_APP_VERSION";

afterEach(() => {
  vi.unstubAllEnvs();
});

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

  it("round-trips requirement overrides through YAML", () => {
    const state = makeValidUiState();
    state.cardsByKind.requirements = [
      {
        uid: "r",
        shiftType: "D",
        requiredNumPeople: 2,
        requiredNumPeopleOverrides: [[state.rangeStart, 1]],
        weight: -1,
      },
    ];
    const yaml = serializeScenario(state);
    expect(yaml).toContain("requiredNumPeopleOverrides");
    const back = importScenarioYaml(yaml);
    expect(back.ok).toBe(true);
    if (back.ok) {
      expect(back.target.cardsByKind.requirements[0].requiredNumPeopleOverrides).toEqual([
        [state.rangeStart, 1],
      ]);
    }
  });

  it("refuses a non-ISO override date", () => {
    const state = makeValidUiState();
    state.cardsByKind.requirements = [
      {
        uid: "r",
        shiftType: "D",
        requiredNumPeople: 2,
        requiredNumPeopleOverrides: [["PH", 1]],
        weight: -1,
      },
    ];
    expect(() => serializeScenario(state)).toThrow();
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

describe("span-id date refs expand to the backend's canonical full ISO (G1)", () => {
  /** Parse the serialized doc's two span-id surfaces out of the YAML. */
  function surfaces(state: ScenarioUiState) {
    const parsed = parse(serializeScenario(state)) as {
      dates: { groups: { id: string; members: unknown[] }[] };
      preferences: { type: string; person?: string; date?: unknown }[];
    };
    return {
      groupMembers: parsed.dates.groups[0].members,
      requestDates: parsed.preferences.filter((p) => p.type === "shift request").map((p) => p.date),
    };
  }

  it("expands the UI's span ids on both surfaces (matrix cells + date-group members)", () => {
    // A same-month roster: `generateDateItems` ids are bare `DD`, which is what
    // the matrix and the Dates screen key by — and what import re-keys onto.
    const state = makeValidUiState();
    state.dateGroups = [{ id: "FirstTwo", members: ["14", "15"] }];
    state.reqData = [
      { uid: "c1", kind: "leave", person: "Alice", date: "14" },
      { uid: "c2", kind: "request", person: "Bob", date: "15", shiftType: "D", weight: 2 },
    ];

    const { groupMembers, requestDates } = surfaces(state);
    expect(groupMembers).toEqual(["2026-05-14", "2026-05-15"]);
    expect(requestDates).toEqual(["2026-05-14", "2026-05-15"]);
  });

  it("leaves every non-generated ref alone — ids, keywords, ranges, and full ISO", () => {
    // The accepting control: only an id `generateDateItems` actually produced is
    // expanded, so an ordinary round trip is untouched and a bad ref stays
    // reportable rather than being folded onto a same-numbered real day.
    const state = makeValidUiState();
    state.dateGroups = [{ id: "Mixed", members: ["WEEKEND", "2026-05-14", "14~15", 14] }];
    state.reqData = [
      { uid: "c1", kind: "leave", person: "Alice", date: "2026-05-14" },
      { uid: "c2", kind: "request", person: "Bob", date: "Mixed", shiftType: "D", weight: 2 },
    ];

    const { groupMembers, requestDates } = surfaces(state);
    expect(groupMembers).toEqual(["WEEKEND", "2026-05-14", "14~15", 14]);
    expect(requestDates).toEqual(["2026-05-14", "Mixed"]);
  });

  it("is identity across a year boundary, where the span id already IS the ISO date", () => {
    const state = makeValidUiState();
    state.rangeStart = "2026-12-30";
    state.rangeEnd = "2027-01-02";
    state.dateGroups = [{ id: "NewYear", members: ["2026-12-31", "2027-01-01"] }];
    state.reqData = [{ uid: "c1", kind: "leave", person: "Alice", date: "2027-01-01" }];

    const { groupMembers, requestDates } = surfaces(state);
    expect(groupMembers).toEqual(["2026-12-31", "2027-01-01"]);
    expect(requestDates).toEqual(["2027-01-01"]);
  });
});

describe("serializeScenario stamps the current build version LAST (FR-SL-02)", () => {
  function fixtureWithoutAppVersion(): ScenarioUiState {
    const state = makeValidUiState();
    delete state.meta.appVersion;
    return state;
  }

  it("emits the current build version as the last top-level key for a new state", () => {
    vi.stubEnv(APP_VERSION_ENV, "9.9.9");
    const yaml = serializeScenario(fixtureWithoutAppVersion());
    const parsed = parse(yaml) as Record<string, unknown>;
    expect(parsed.appVersion).toBe("9.9.9");
    expect(Object.keys(parsed).at(-1)).toBe("appVersion");
  });

  it("overrides an imported/stale meta.appVersion with the current build version", () => {
    const state = makeValidUiState();
    state.meta.appVersion = "0.0.1-old";
    vi.stubEnv(APP_VERSION_ENV, "9.9.9");
    const yaml = serializeScenario(state);
    const parsed = parse(yaml) as Record<string, unknown>;
    expect(parsed.appVersion).toBe("9.9.9");
  });

  it("preserves a -dirty build suffix verbatim (exact-string passthrough)", () => {
    vi.stubEnv(APP_VERSION_ENV, "9.9.9-dirty");
    const yaml = serializeScenario(fixtureWithoutAppVersion());
    const parsed = parse(yaml) as Record<string, unknown>;
    expect(parsed.appVersion).toBe("9.9.9-dirty");
  });
});
