import { describe, expect, it } from "vitest";

import { createEmptyScenarioUiState, type ScenarioUiState } from "@/lib/scenario";
import {
  ASSISTANT_AUTHORITY_STATEMENT,
  buildAssistantContext,
  stringifyScenario,
  summarizeScenario,
} from "./scenario-context";
import { SENTINEL_KEY } from "./test-support";

function wardScenario(): ScenarioUiState {
  const base = createEmptyScenarioUiState();
  return {
    ...base,
    meta: { ...base.meta, description: "Ward 4B September" },
    rangeStart: "2026-09-01",
    rangeEnd: "2026-09-30",
    staff: [{ id: "alice", description: "Alice Tan" }],
    reqData: [
      { uid: "c1", person: "alice", date: "2026-09-15", kind: "leave" },
      {
        uid: "c2",
        person: "alice",
        date: "2026-09-16",
        kind: "off",
        weight: Number.POSITIVE_INFINITY,
      },
    ],
  };
}

describe("scenario serialization for the model", () => {
  it("preserves signed infinities as the strict YAML markers, never as null", () => {
    const json = stringifyScenario(wardScenario());

    // A hard constraint serialized as `null` would present every hard rule as an
    // absent one -- the model would reason about a document the user does not have.
    expect(json).toContain('".inf"');
    expect(json).not.toMatch(/"weight":null/);
  });

  it("sends the complete document, identifiers and all -- the closed posture", () => {
    const json = stringifyScenario(wardScenario());

    expect(json).toContain("Alice Tan");
    expect(json).toContain("2026-09-15");
  });
});

describe("the attached turn context", () => {
  const context = buildAssistantContext({
    scenario: wardScenario(),
    scenarioId: "scenario-a",
    documentRevision: 12,
    routePath: "/shift-requests",
    routeLabel: "Requests & Leave",
  });

  it("is exactly the authority statement, the document, and the current screen", () => {
    expect(context).toHaveLength(3);
    expect(context[0].description).toBe(ASSISTANT_AUTHORITY_STATEMENT);
  });

  it("tells the model to propose supported changes via Preview, never to apply them itself", () => {
    // Regression: the old read-only text denied the propose-then-Apply path, so
    // the model refused changes prepare_scenario_change supports.
    expect(ASSISTANT_AUTHORITY_STATEMENT).not.toMatch(/no tool that edits/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/prepare_scenario_change/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/Preview/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/user .*Apply/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/instead of refusing/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/open_app_screen/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/Never claim .*applied/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/request_optimize_run/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/only when the user presses Run/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/get_optimize_result/);
  });

  it("carries the route and the exact revision the document was read at", () => {
    const screen = JSON.parse(context[2].value) as Record<string, unknown>;
    expect(screen).toEqual({
      path: "/shift-requests",
      label: "Requests & Leave",
      scenarioId: "scenario-a",
      documentRevision: 12,
    });
  });

  it("contains no credential -- the key is a request header, never context", () => {
    expect(JSON.stringify(context)).not.toContain(SENTINEL_KEY);
    expect(JSON.stringify(context).toLowerCase()).not.toContain("apikey");
    expect(JSON.stringify(context).toLowerCase()).not.toContain("authorization");
  });
});

describe("host-derived summary", () => {
  it("counts each domain from the document rather than from the conversation", () => {
    const summary = summarizeScenario(wardScenario(), {
      scenarioId: "scenario-a",
      documentRevision: 12,
    });

    expect(summary).toMatchObject({
      scenarioId: "scenario-a",
      documentRevision: 12,
      description: "Ward 4B September",
      rosterPeriod: { start: "2026-09-01", end: "2026-09-30" },
    });
    expect(summary.counts.people).toBe(1);
    expect(summary.counts.requestCells).toBe(2);
  });
});
