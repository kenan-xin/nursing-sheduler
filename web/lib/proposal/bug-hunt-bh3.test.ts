// Bug hunt BH3 (bead 8g1f): assistant operations the host used to accept or mis-report.
import { describe, expect, it } from "vitest";
import { applyAssistantCommands } from "./operations";
import { prepareProposal } from "./prepare";
import { FIXTURE_STAMP, octoberWard, proposalScenario, ruleWardScenario } from "./test-support";
import type { AssistantCommandV1 } from "./commands";
import type { ScenarioUiState } from "@/lib/scenario";
import { validateCover } from "@/lib/scenario/temporary-cover";
import {
  buildRequirementShiftTypeDomain,
  REQUIREMENT_MESSAGES,
  requirementToForm,
  validateRequirementForm,
} from "@/components/requirements/requirements-model";

function prep(document: ScenarioUiState, commands: AssistantCommandV1[]) {
  return prepareProposal({
    proposalId: "p",
    revision: 1,
    scenarioId: "s",
    threadId: null,
    turnId: null,
    document,
    baseDocumentRevision: 1,
    baseCommitId: null,
    leaseEpoch: 1,
    registryStamp: FIXTURE_STAMP,
    commands,
    rationale: null,
    evidence: [],
    outcome: "untested",
    globalGeneration: 0,
    scenarioGeneration: 0,
    now: new Date(0),
  });
}

const refusal = (result: ReturnType<typeof applyAssistantCommands>) =>
  result.ok ? "" : result.rejection.message;

describe("C1 set_staffing_requirement_people above the preferred count", () => {
  it("is refused: the optimiser would get at least 3 and at most 2", () => {
    const s = ruleWardScenario();
    s.cardsByKind.requirements = [
      {
        uid: "req-day",
        description: "Day cover",
        shiftType: ["Day"],
        requiredNumPeople: 1,
        preferredNumPeople: 2,
        qualifiedPeople: ["ALL"],
        date: ["ALL"],
        weight: -50,
      },
    ];
    const result = applyAssistantCommands(s, [
      { type: "set_staffing_requirement_people", ruleId: "req-day", requiredNumPeople: 3 },
    ]);
    expect(refusal(result)).toMatch(/preferred number of people/i);
    // Up to the preferred count is still fine.
    expect(
      applyAssistantCommands(s, [
        { type: "set_staffing_requirement_people", ruleId: "req-day", requiredNumPeople: 2 },
      ]).ok,
    ).toBe(true);
  });
});

describe("C2 fractional head counts", () => {
  it("add_staffing_requirement with 1.5 people is refused", () => {
    const result = applyAssistantCommands(ruleWardScenario(), [
      {
        type: "add_staffing_requirement",
        description: "x",
        shiftType: "Night",
        qualifiedPeople: ["ALL"],
        dates: ["ALL"],
        requiredNumPeople: 1.5,
      },
    ]);
    expect(refusal(result)).toMatch(/whole number/);
  });

  it("set_staffing_requirement_people with 2.5 is refused", () => {
    const result = applyAssistantCommands(proposalScenario(), [
      { type: "set_staffing_requirement_people", ruleId: "req-day", requiredNumPeople: 2.5 },
    ]);
    expect(refusal(result)).toMatch(/whole number/);
  });

  it("the Staffing requirements form refuses 1.5 required and 2.5 preferred", () => {
    const state = proposalScenario();
    const domain = buildRequirementShiftTypeDomain(state);
    const form = requirementToForm(
      state.cardsByKind.requirements.find((c) => c.uid === "req-day")!,
      domain,
    );
    expect(validateRequirementForm({ ...form, requiredNumPeople: 1.5 }, domain)).toMatchObject({
      requiredNumPeople: REQUIREMENT_MESSAGES.requiredWhole,
    });
    expect(
      validateRequirementForm({ ...form, requiredNumPeople: 1, preferredNumPeople: 2.5 }, domain),
    ).toMatchObject({ preferredNumPeople: REQUIREMENT_MESSAGES.preferredWhole });
  });
});

describe("C3 a person id containing '|'", () => {
  it("prepares a Preview for a request change on that person", () => {
    const commands: AssistantCommandV1[] = [
      { type: "add_person", name: "Float | Ward 3", groups: [] },
      {
        type: "set_off_request",
        personId: "Float | Ward 3",
        startDate: "2026-10-01",
        endDate: "2026-10-01",
        weight: 20,
      },
    ];
    const result = prep(octoberWard(), commands);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal.diff.direct.map((entry) => entry.label)).toContain(
        "Float | Ward 3 on Thu 1 Oct",
      );
    }
  });
});

describe("C5 move_leave onto a date that already holds leave", () => {
  it("is refused instead of silently losing a leave day", () => {
    const s = octoberWard();
    s.reqData.push({ uid: "ana-leave-15", person: "Ana", date: "15", kind: "leave" });
    const result = applyAssistantCommands(s, [
      { type: "move_leave", personId: "Ana", fromDate: "14", toDate: "15" },
    ]);
    expect(refusal(result)).toMatch(/already on leave/);
  });
});

describe("C7 add_temporary_cover outside the roster period", () => {
  const cover = { name: "Nurse A (Ward X)", date: "2026-12-05", shiftType: "N", groups: [] };
  const ward = () => {
    const s = octoberWard();
    s.cardsByKind.requirements = [
      {
        uid: "n",
        description: "Night",
        shiftType: ["N"],
        requiredNumPeople: 2,
        qualifiedPeople: ["ALL"],
        date: ["ALL"],
        weight: -1,
      },
    ];
    return s;
  };

  it("is refused when adding", () => {
    const result = applyAssistantCommands(ward(), [{ type: "add_temporary_cover", ...cover }]);
    expect(refusal(result)).toMatch(/roster period/);
  });

  it("is still accepted when re-saving a drifted entry (F3 flags it instead)", () => {
    const s = { ...ward(), temporaryCover: [cover] };
    expect(validateCover(s, cover, 0)).toEqual({ ok: true });
  });
});

describe("C9 hoursPerShift off the half-hour grid", () => {
  it("the refusal names the half-hour grid", () => {
    const result = applyAssistantCommands(ruleWardScenario(), [
      {
        type: "add_contracted_hours",
        description: "Contract",
        people: ["ana"],
        dates: ["ALL"],
        minHours: 160,
        maxHours: 180,
        hoursPerShift: 7.25,
      },
    ]);
    expect(refusal(result)).toMatch(/half-hour/);
  });
});
