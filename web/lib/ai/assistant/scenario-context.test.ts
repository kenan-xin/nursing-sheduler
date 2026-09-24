import { describe, expect, it, vi } from "vitest";

import { createEmptyScenarioUiState, type ScenarioUiState } from "@/lib/scenario";
import {
  ASSISTANT_AUTHORITY_STATEMENT,
  KNOWLEDGE_LINES,
  buildAssistantContext,
  describeToday,
  stringifyScenario,
  summarizeScenario,
} from "./scenario-context";
import { REST_PRACTICE_WARNING } from "./playbook";
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

  it("tells law from guidance: rest rules are guidance it prepares with a warning, never refuses", () => {
    expect(ASSISTANT_AUTHORITY_STATEMENT).toContain(REST_PRACTICE_WARNING);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/recommended practice, not law/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/MOH sets no minimum rest/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/turn it off rather than delete it/);
    // The Employment Act, stated exactly.
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/1 rest day a week/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/12 working hours a day, including overtime/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/44 hours a week averaged over 3 weeks/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/72 hours of overtime a month/);
    // Working hours, never the clock span.
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/minus its unpaid break/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/08:00 to 20:30 .*10\.5 hours/);
    // Never a numeric MOH rest minimum.
    expect(ASSISTANT_AUTHORITY_STATEMENT).not.toMatch(/MOH[^.]*\d+\s*hours/);
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

describe("what the assistant knows about the ward and the solver", () => {
  it("is not a source of law beyond the Employment Act, and hands the rule back to the ward", () => {
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/not a source of law or policy/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/ward decides/);
    // The Employment Act facts stay law (d3cc420); the new line must not deny them.
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/The law \(Employment Act\) is/);
    expect(KNOWLEDGE_LINES.join(" ")).not.toMatch(/employment law/i);
  });
  it("says a staffing number is exact and where the preferred count lives", () => {
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/exact, not a minimum/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/Staffing requirements screen/);
  });
  it("sets a skill mix with set_skill_mix, and never approximates it with a whole-shift group", () => {
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/skill mix .*set_skill_mix/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).not.toMatch(/not supported yet/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/never approximate it/);
  });
  it("checks the limits before promising a rule", () => {
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/explain_app_capability/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/scheduler-limits/);
  });
  it("warns that a new run can change everyone's shifts", () => {
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/change everyone's shifts/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/Roster screen/);
  });
  it("leaves a same-day-off clash to whoever decides leave", () => {
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/never decide it yourself/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/whoever decides leave/);
  });
  it("sends a one-off roster change through the whole cover ladder, not only swaps", () => {
    expect(KNOWLEDGE_LINES.join(" ")).toMatch(/cover steps above/);
  });
  it("does not repeat the rest-number ban in the no-law line", () => {
    expect(KNOWLEDGE_LINES[0]).not.toMatch(/rest/);
  });
  it("keeps every knowledge line short", () => {
    for (const line of KNOWLEDGE_LINES) expect(line.split(/\s+/).length, line).toBeLessThan(45);
  });
});

describe("a prepared change is spoken of as prepared, never done", () => {
  it("says 'I've prepared ...; check it and press Apply', never past tense before Apply", () => {
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/I've prepared/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/check it and press Apply/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/never .*past tense/);
  });
});
