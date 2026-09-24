import { describe, expect, it, vi } from "vitest";

import { createEmptyScenarioUiState, type ScenarioUiState } from "@/lib/scenario";
import {
  ASSISTANT_AUTHORITY_STATEMENT,
  buildAssistantContext,
  describeToday,
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
  it("points the model at guided setup and at the repair options", () => {
    // WIDENED DELIBERATELY (2026-09-24, plan assistant-guided-setup-and-repair).
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/get_setup_progress/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/suggest_feasibility_options/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/at most three/);
  });

  it("tells the model to take ids from the schedule and never guess a name", () => {
    // 2026-09-24, plan assistant-self-correction: "apply a rule to everyone" made the
    // model invent names instead of reading the staff list.
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/get_schedule_section/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/never guess/i);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/valid ones/);
  });

  const context = buildAssistantContext({
    scenario: wardScenario(),
    scenarioId: "scenario-a",
    documentRevision: 12,
    routePath: "/shift-requests",
    routeLabel: "Requests & Leave",
    now: new Date(2026, 8, 24, 9, 30),
  });

  it("is exactly the authority statement, the document, the current screen and today", () => {
    expect(context).toHaveLength(4);
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
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/opens the screen that holds the change/);
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

  it("tells the model today's date, from the injected clock", () => {
    expect(context[3].value).toBe("2026-09-24 (Thursday 24 September 2026)");
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/month without a year/);
  });

  it("uses the LOCAL date where it differs from the UTC one", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    try {
      const lateEvening = new Date(2026, 8, 24, 23, 30);
      // The premise: in UTC this moment is already the 25th.
      expect(lateEvening.toISOString().slice(0, 10)).toBe("2026-09-25");
      expect(describeToday(lateEvening)).toBe("2026-09-24 (Thursday 24 September 2026)");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("tells the model to carry on after an Apply or a failed run", () => {
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/says they applied a change/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/do not ask them to confirm again/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(
      /run finished and failed.*get_optimize_result.*suggest_feasibility_options.*offer_choices/,
    );
  });

  it("tells the model to read the roster and to swap only through the card", () => {
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/get_roster/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/find_swap_partners.*prepare_roster_swap/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/never ask the user who works/i);
  });

  it("tells the model to follow the ward's escalation ladder and name the step", () => {
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/step 1.*step 2.*step 3.*step 4/i);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/overtime pay, or off-in-lieu/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/nurse manager's sign-off/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(
      /let their nurse manager or nurse clinician know/,
    );
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/prepare_borrowed_cover/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/sick_or_emergency/);
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
