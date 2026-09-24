// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  assistantActions,
  turnAwaitsUserOnCard,
  useAssistantStore,
} from "@/lib/ai/assistant/store";
import { generateDateItems } from "@/lib/dates/date-id";
import { useRosterChangeStore } from "@/lib/roster/change-request";
import { fixtureSubmission } from "@/lib/roster/test-fixtures";
import { PREFERENCE_TYPE, type CanonicalScenarioDocument } from "@/lib/scenario";
import {
  ashaRosterDocument,
  borrowRosterDocument,
  overtimeContext,
  overtimeDocument,
  overtimeGrid,
  priyaRosterDocument,
  shortRosterDocument,
} from "@/lib/roster-viewer/swap-fixtures";
import { MODEL_VISIBLE_TOOL_SCHEMAS } from "./model-visible-tools";
import {
  borrowParameters,
  rosterReadParameters,
  swapPartnerParameters,
  swapPrepareParameters,
  useRosterTools,
} from "./use-roster-tools";
import { bindTurnForTest, type TestTurnHandle } from "./turn-authority.test-support";

interface CapturedTool {
  name: string;
  handler: (args: unknown, context: { signal?: AbortSignal }) => Promise<unknown>;
}
const captured: CapturedTool[] = [];
vi.mock("@copilotkit/react-core/v2", () => ({
  useFrontendTool: (definition: CapturedTool) => {
    if (!captured.some((tool) => tool.name === definition.name)) captured.push(definition);
  },
  useCopilotKit: () => ({ copilotkit: {} }),
}));

const fixture = vi.hoisted(() => ({
  working: null as unknown,
  pointer: null as unknown,
  scenario: null as unknown,
  prepare: vi.fn(),
  cancel: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store")>();
  return {
    ...actual,
    pickScenario: () => fixture.scenario,
    assistantProposalCommands: {
      ...actual.assistantProposalCommands,
      prepare: fixture.prepare,
      cancel: fixture.cancel,
    },
    rosterStorage: {
      ...actual.rosterStorage,
      readWorking: async () => fixture.working,
      readCurrentCandidate: async () => fixture.pointer,
    },
  };
});

const TURN = 5;
let boundTurn: TestTurnHandle;

function Host() {
  useRosterTools("scheduler:thread-1", TURN);
  return null;
}
const tool = (name: string) => {
  const found = captured.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`tool "${name}" was never registered`);
  return found;
};

beforeEach(() => {
  captured.length = 0;
  fixture.working = {
    document: priyaRosterDocument(),
    revision: 1,
    candidateSource: { jobId: "job-1", candidateVersion: 1 },
  };
  fixture.pointer = { jobId: "job-1", candidateVersion: 1, submissionOrdinal: 1 };
  fixture.scenario = { rangeStart: "2026-10-07", rangeEnd: "2026-10-14" };
  fixture.prepare.mockReset().mockResolvedValue({
    ok: true,
    proposal: {
      proposalId: "p-1",
      assumptions: [
        {
          assumptionId: "a-1",
          type: "leave_moved",
          question: "Has SN-Asha agreed to move their leave?",
        },
      ],
    },
  });
  useAssistantStore.setState({ turnEpoch: TURN });
  useRosterChangeStore.setState({ pending: null, last: null });
  boundTurn = bindTurnForTest({ turnEpoch: TURN });
  render(<Host />);
});

afterEach(() => {
  boundTurn.release();
  cleanup();
  assistantActions.resetForTest();
});

const PRIYA_NIGHTS = { person: "SN-Priya", dates: ["2026-10-08", "2026-10-09"], reason: "swap" };

describe("the roster tools", () => {
  it("registers exactly the four tools", () => {
    expect(captured.map((t) => t.name).sort()).toEqual([
      "find_swap_partners",
      "get_roster",
      "prepare_borrowed_cover",
      "prepare_roster_swap",
    ]);
  });

  it("offers them to the model under the same names and schemas", () => {
    // A tool mounted but missing from this list never reaches the provider, while every
    // other suite stays green. So the list must carry these exact schemas.
    expect(MODEL_VISIBLE_TOOL_SCHEMAS.get_roster).toBe(rosterReadParameters);
    expect(MODEL_VISIBLE_TOOL_SCHEMAS.find_swap_partners).toBe(swapPartnerParameters);
    expect(MODEL_VISIBLE_TOOL_SCHEMAS.prepare_roster_swap).toBe(swapPrepareParameters);
    expect(MODEL_VISIBLE_TOOL_SCHEMAS.prepare_borrowed_cover).toBe(borrowParameters);
  });

  it("refuses an empty list of dates in both swap tools", async () => {
    for (const name of ["find_swap_partners", "prepare_roster_swap"]) {
      const answer = await tool(name).handler(
        { person: "SN-Priya", dates: [], reason: "swap", partner: "SN-Cara", summary: "Swap." },
        {},
      );
      expect(answer).toMatch(/not a valid call/);
    }
    expect(useAssistantStore.getState().activeRosterChange).toBeNull();
  });
});

describe("get_roster", () => {
  it("reads who works what", async () => {
    const answer = (await tool("get_roster").handler({ people: ["Priya"] }, {})) as {
      rows: unknown;
    };
    expect(answer.rows).toEqual([{ person: "SN-Priya", days: ["AM", "N", "N", "OFF", "OFF"] }]);
  });

  it("says there is no roster yet and how to get one", async () => {
    fixture.working = null;
    fixture.pointer = null;
    expect(await tool("get_roster").handler({}, {})).toMatch(
      /no saved roster.*request_optimize_run/i,
    );
  });

  it("reports the last change outcome", async () => {
    useRosterChangeStore.setState({ pending: null, last: "roster-changed" });
    const answer = (await tool("get_roster").handler({}, {})) as { lastChange?: string };
    expect(answer.lastChange).toMatch(/NOT applied/);
  });
});

describe("find_swap_partners", () => {
  it("ranks who can take Priya's nights and says who cannot", async () => {
    const answer = (await tool("find_swap_partners").handler(PRIYA_NIGHTS, {})) as {
      candidates: { partner: string; kind: string }[];
      ruledOutExamples: { partner: string; reason: string }[];
    };
    expect(answer.candidates.map((c) => [c.partner, c.kind])).toEqual([
      ["SN-Cara", "cover"],
      ["SN-Eve", "exchange"],
    ]);
    expect(answer.ruledOutExamples[0]).toEqual({
      partner: "SN-Ana",
      reason:
        "SN-Ana works N on 9 Oct, then AM on 10 Oct, which “No morning after night” does not allow.",
    });
  });

  it("refuses a date outside the roster", async () => {
    expect(
      await tool("find_swap_partners").handler(
        { person: "SN-Priya", dates: ["2026-11-01"], reason: "swap" },
        {},
      ),
    ).toMatch(/outside this roster/);
  });

  it("refuses to swap while a newer run waits", async () => {
    fixture.pointer = { jobId: "job-2", candidateVersion: 1, submissionOrdinal: 2 };
    expect(await tool("find_swap_partners").handler(PRIYA_NIGHTS, {})).toMatch(/press Load/);
  });
});

describe("prepare_roster_swap", () => {
  it("refuses a rule-breaking swap and shows no card", async () => {
    const answer = await tool("prepare_roster_swap").handler(
      { ...PRIYA_NIGHTS, partner: "SN-Ana", summary: "Swap." },
      {},
    );
    expect(answer).toMatch(/No morning after night/);
    expect(useAssistantStore.getState().activeRosterChange).toBeNull();
  });

  it("shows a card stamped with the turn and changes nothing", async () => {
    const answer = await tool("prepare_roster_swap").handler(
      { ...PRIYA_NIGHTS, partner: "SN-Cara", summary: "Priya needs those nights off." },
      {},
    );
    expect(answer).toMatch(/Nothing has changed/);
    const card = useAssistantStore.getState().activeRosterChange;
    expect(card?.turnEpoch).toBe(TURN);
    expect(card?.request?.cells).toHaveLength(4);
    expect(card?.request?.solvedBaselineId).toBe("a".repeat(64));
    expect(card?.linked).toBeNull();
    expect(useRosterChangeStore.getState().pending).toBeNull();
  });
});

const useAsha = () => {
  fixture.working = {
    document: ashaRosterDocument(),
    revision: 1,
    candidateSource: { jobId: "job-1", candidateVersion: 1 },
  };
};
const useBorrow = () => {
  fixture.working = {
    document: borrowRosterDocument(),
    revision: 1,
    candidateSource: { jobId: "job-1", candidateVersion: 1 },
  };
  fixture.scenario = { rangeStart: "2026-10-07", rangeEnd: "2026-10-09" };
};
const useShort = () => {
  fixture.working = {
    document: shortRosterDocument(),
    revision: 1,
    candidateSource: { jobId: "job-1", candidateVersion: 1 },
  };
};
const idFor = (iso: string) =>
  generateDateItems({ start: "2026-10-07", end: "2026-10-14" }).find((item) => item.iso === iso)
    ?.id;
const BORROW_MEI = {
  person: "SN-Priya",
  dates: ["2026-10-08"],
  reason: "sick_or_emergency",
  name: "Mei",
  source: "relief_pool",
  groups: [],
};

describe("the escalation ladder in the tools", () => {
  it("says step 1 when a swap or cover exists", async () => {
    const answer = (await tool("find_swap_partners").handler(PRIYA_NIGHTS, {})) as {
      step: number;
      stepLabel: string;
    };
    expect(answer.step).toBe(1);
    expect(answer.stepLabel).toBe("Step 1 · Swap or cover within the ward");
  });

  it("offers step 2 trades with concrete later dates only when step 1 is empty", async () => {
    useAsha();
    const answer = (await tool("find_swap_partners").handler(PRIYA_NIGHTS, {})) as {
      step: number;
      candidates: unknown[];
      trades: { partner: string; laterDates: string[]; movesLeave: boolean; payBack: string }[];
    };
    expect(answer.step).toBe(2);
    expect(answer.candidates).toEqual([]);
    expect(answer.trades.map((t) => [t.partner, t.laterDates, t.movesLeave])).toEqual([
      ["SN-Cy", ["2026-10-10", "2026-10-11"], false],
      ["SN-Asha", ["2026-10-11", "2026-10-12"], true],
    ]);
    expect(answer.trades.every((t) => t.payBack === "off-in-lieu")).toBe(true);
  });

  it("prepares the Asha trade as roster cells plus a linked leave move", async () => {
    useAsha();
    const answer = await tool("prepare_roster_swap").handler(
      {
        ...PRIYA_NIGHTS,
        partner: "SN-Asha",
        laterDates: ["2026-10-11", "2026-10-12"],
        summary: "Priya needs those nights off.",
      },
      {},
    );
    expect(answer).toMatch(/Nothing has changed/);
    expect(fixture.prepare).toHaveBeenCalledTimes(1);
    expect(fixture.prepare.mock.calls[0][0].commands).toEqual([
      {
        type: "move_leave",
        personId: "SN-Asha",
        fromDate: idFor("2026-10-08"),
        toDate: idFor("2026-10-11"),
      },
      {
        type: "move_leave",
        personId: "SN-Asha",
        fromDate: idFor("2026-10-09"),
        toDate: idFor("2026-10-12"),
      },
    ]);
    const card = useAssistantStore.getState().activeRosterChange;
    expect(card?.linked).toEqual({ proposalId: "p-1", assumptionIds: ["a-1"], record: "leave" });
    expect(card?.view.agreement).toMatch(
      /^SN-Asha agreed to come in on 8–9 Oct and take leave on 11–12 Oct instead/,
    );
    expect(useAssistantStore.getState().activeProposal).toBeNull();
  });

  it("refuses a trade while step 1 still has a swap or cover, and lists them", async () => {
    const answer = await tool("prepare_roster_swap").handler(
      {
        ...PRIYA_NIGHTS,
        partner: "SN-Ben",
        laterDates: ["2026-10-10", "2026-10-11"],
        summary: "Trade.",
      },
      {},
    );
    expect(answer).toMatch(/Step 1 still has options/);
    expect(answer).toMatch(/SN-Cara, SN-Eve/);
    expect(answer).not.toMatch(/\b(AM|PM|N|OFF|LEAVE)\b/);
    expect(fixture.prepare).not.toHaveBeenCalled();
    expect(useAssistantStore.getState().activeRosterChange).toBeNull();
  });

  it("lists the ranked partners when the named partner is unknown", async () => {
    const answer = await tool("prepare_roster_swap").handler(
      { ...PRIYA_NIGHTS, partner: "SN-Zed", summary: "Swap." },
      {},
    );
    expect(answer).toMatch(/No one called "SN-Zed"/);
    expect(answer).toMatch(/SN-Cara, SN-Eve/);
    expect(answer).not.toMatch(/Use a partner from find_swap_partners/);
  });

  it("falls back to the people on the roster when nobody can take the shifts", async () => {
    useBorrow();
    const answer = await tool("prepare_roster_swap").handler(
      {
        person: "SN-Priya",
        dates: ["2026-10-08"],
        reason: "swap",
        partner: "SN-Zed",
        summary: "Swap.",
      },
      {},
    );
    expect(answer).toMatch(/No one called "SN-Zed"/);
    expect(answer).toMatch(/SSN-Dev/);
  });

  it("records sick leave in the roster and the leave record together", async () => {
    const answer = await tool("prepare_roster_swap").handler(
      {
        person: "SN-Priya",
        dates: ["2026-10-08"],
        reason: "sick_or_emergency",
        partner: "SN-Cara",
        summary: "Priya is on MC.",
      },
      {},
    );
    expect(answer).toMatch(/Nothing has changed/);
    expect(fixture.prepare.mock.calls[0][0].commands).toEqual([
      { type: "add_leave", personId: "SN-Priya", startDate: "2026-10-08", endDate: "2026-10-08" },
    ]);
    expect(useAssistantStore.getState().activeRosterChange?.request?.cells[0].after).toEqual({
      kind: "leave",
    });
  });

  it("refuses to borrow while a lower step has options", async () => {
    const answer = await tool("prepare_borrowed_cover").handler(
      { ...BORROW_MEI, summary: "Borrow." },
      {},
    );
    expect(answer).toMatch(/Step 1 still has options/);
    expect(fixture.prepare).not.toHaveBeenCalled();
  });

  it("prepares step 3 with shipped ops and the skill group the night needs", async () => {
    useBorrow();
    const found = (await tool("find_swap_partners").handler(
      { person: "SN-Priya", dates: ["2026-10-08"], reason: "sick_or_emergency" },
      {},
    )) as { step: number; temporary: { needs: unknown[]; skillGroups: string[] } };
    expect(found.step).toBe(3);
    expect(found.temporary.skillGroups).toEqual(["Nights"]);
    fixture.prepare.mockResolvedValueOnce({
      ok: true,
      proposal: {
        proposalId: "p-2",
        assumptions: [
          {
            assumptionId: "b-1",
            type: "borrowed_staff_arranged",
            question:
              "Has the lending ward or agency confirmed Mei for 8 Oct, qualified as Nights?",
          },
        ],
      },
    });
    const answer = await tool("prepare_borrowed_cover").handler(
      { ...BORROW_MEI, summary: "Borrow from Ward 6." },
      {},
    );
    expect(fixture.prepare.mock.calls[0][0].commands).toEqual([
      { type: "add_person", name: "Mei", groups: ["Nights"], temporary: true },
      {
        type: "set_off_request",
        personId: "Mei",
        startDate: "2026-10-07",
        endDate: "2026-10-07",
        weight: "must",
      },
      {
        type: "set_off_request",
        personId: "Mei",
        startDate: "2026-10-09",
        endDate: "2026-10-09",
        weight: "must",
      },
      {
        type: "set_shift_request",
        personId: "Mei",
        shiftType: "N",
        startDate: "2026-10-08",
        endDate: "2026-10-08",
        weight: "must",
      },
      { type: "add_leave", personId: "SN-Priya", startDate: "2026-10-08", endDate: "2026-10-08" },
    ]);
    expect(fixture.prepare.mock.calls[0][0].rationale).toBe("Borrow from Ward 6. (relief pool)");
    const card = useAssistantStore.getState().activeRosterChange;
    expect(card?.view.agreement).toBe(
      "Has the lending ward or agency confirmed Mei for 8 Oct, qualified as Nights?",
    );
    expect(card?.request?.cells).toEqual([
      {
        personIdx: 0,
        dateIdx: 1,
        before: { kind: "shift", shiftId: "N" },
        after: { kind: "leave" },
      },
    ]);
    expect(card?.view.title).toBe("Mei (relief pool): Night on 8 Oct");
    expect(card?.linked?.record).toBe("staff");
    expect(answer).toMatch(/nurse manager or nurse clinician/);
  });

  it("cancels the linked proposal of a card it replaces", async () => {
    assistantActions.showRosterChange(
      {
        request: null,
        view: useAssistantStore.getState().activeRosterChange?.view ?? ({} as never),
        linked: { proposalId: "old-p", assumptionIds: [], record: "leave" },
      },
      TURN,
    );
    fixture.cancel.mockClear();
    await tool("prepare_roster_swap").handler(
      { ...PRIYA_NIGHTS, partner: "SN-Cara", summary: "Priya needs those nights off." },
      {},
    );
    expect(fixture.cancel).toHaveBeenCalledWith("old-p");
  });

  it("frees the asking nurse at the next run when step 3 covers a swap", async () => {
    useBorrow();
    fixture.prepare.mockResolvedValueOnce({
      ok: true,
      proposal: {
        proposalId: "p-2",
        assumptions: [
          { assumptionId: "b-1", type: "borrowed_staff_arranged", question: "Confirmed Mei?" },
        ],
      },
    });
    const answer = await tool("prepare_borrowed_cover").handler(
      { ...BORROW_MEI, reason: "swap", summary: "Borrow." },
      {},
    );
    const commands = fixture.prepare.mock.calls[0][0].commands;
    expect(commands).toContainEqual({
      type: "set_off_request",
      personId: "SN-Priya",
      startDate: "2026-10-08",
      endDate: "2026-10-08",
      weight: "must",
    });
    expect(commands.some((c: { type: string }) => c.type === "add_leave")).toBe(false);
    const card = useAssistantStore.getState().activeRosterChange;
    expect(card?.request).toBeNull();
    expect(card?.view.notes).toContain(
      "The swap takes effect after the next run: SN-Priya keeps these shifts until then.",
    );
    expect(answer).toMatch(/swap takes effect after the next optimiser run/);
  });

  it("shows no new card while the last one is applying, and cancels what it prepared", async () => {
    useAsha();
    fixture.cancel.mockClear();
    assistantActions.setRosterChangeApplying(true);
    const answer = await tool("prepare_roster_swap").handler(
      {
        ...PRIYA_NIGHTS,
        partner: "SN-Asha",
        laterDates: ["2026-10-11", "2026-10-12"],
        summary: "Priya needs those nights off.",
      },
      {},
    );
    expect(answer).toMatch(/applying the last roster change right now/);
    expect(useAssistantStore.getState().activeRosterChange).toBeNull();
    expect(fixture.cancel).toHaveBeenCalledWith("p-1");
  });

  it("keeps nurse-facing guidance free of she/her and names the nurse manager for borrowing", async () => {
    const texts: string[] = [];
    const guidance = async (args: unknown) =>
      texts.push(
        ((await tool("find_swap_partners").handler(args, {})) as { guidance: string }).guidance,
      );
    await guidance(PRIYA_NIGHTS);
    useAsha();
    await guidance(PRIYA_NIGHTS);
    useBorrow();
    await guidance({ person: "SN-Priya", dates: ["2026-10-08"], reason: "sick_or_emergency" });
    expect(texts[2]).toMatch(/nurse manager or nurse clinician/);
    useShort();
    await guidance({
      person: "SN-Priya",
      dates: ["2026-10-08"],
      reason: "swap",
      noTemporaryNurse: true,
    });
    const described = captured.map((t) => (t as { description?: string }).description ?? "");
    const fields = Object.values(borrowParameters.shape).map((f) => f.description ?? "");
    for (const text of [...texts, ...described, ...fields]) {
      expect(text).not.toMatch(/\b(she|her|hers)\b/i);
    }
  });

  it("asks an off nurse with no spare capacity to come in for overtime (step 2)", async () => {
    fixture.working = {
      document: {
        ...borrowRosterDocument(),
        submission: fixtureSubmission(overtimeDocument(), []),
        context: overtimeContext(),
        solvedDays: overtimeGrid(),
      },
      revision: 1,
      candidateSource: { jobId: "job-1", candidateVersion: 1 },
    };
    fixture.scenario = { rangeStart: "2026-10-07", rangeEnd: "2026-10-09" };
    const found = (await tool("find_swap_partners").handler(
      { person: "SN-Priya", dates: ["2026-10-08"], reason: "sick_or_emergency" },
      {},
    )) as { step: number; overtime: { partner: string; payBack: string }[] };
    expect(found.step).toBe(2);
    expect(found.overtime).toEqual([
      expect.objectContaining({ partner: "SN-Kai", payBack: "overtime" }),
    ]);
    await tool("prepare_roster_swap").handler(
      {
        person: "SN-Priya",
        dates: ["2026-10-08"],
        reason: "sick_or_emergency",
        partner: "SN-Kai",
        summary: "Priya is on MC.",
      },
      {},
    );
    expect(useAssistantStore.getState().activeRosterChange?.view.agreement).toBe(
      "SN-Kai agreed to come in on 8 Oct for overtime pay.",
    );
  });

  it("refuses an overtime request while step 1 still has a cover, and lists it", async () => {
    // The overtime fixture plus SN-Joy, who has spare nights under a count rule: step 1.
    const base = overtimeDocument();
    const document = {
      ...base,
      people: {
        items: [...base.people.items, { id: "SN-Joy" }],
        groups: [{ id: "Nights", members: ["SN-Priya", "SN-Kai", "SN-Joy"] }],
      },
      preferences: [
        ...base.preferences,
        {
          type: PREFERENCE_TYPE.shiftCount,
          description: "Joy max 3 nights",
          person: "SN-Joy",
          countDates: "ALL",
          countShiftTypes: "N",
          expression: "x <= T",
          target: 3,
          weight: Infinity,
        },
      ],
    } as CanonicalScenarioDocument;
    fixture.working = {
      document: {
        ...borrowRosterDocument(),
        submission: fixtureSubmission(document, []),
        context: { ...overtimeContext(), people: [...overtimeContext().people, { id: "SN-Joy" }] },
        solvedDays: [...overtimeGrid(), [{ kind: "off" }, { kind: "off" }, { kind: "off" }]],
      },
      revision: 1,
      candidateSource: { jobId: "job-1", candidateVersion: 1 },
    };
    const answer = await tool("prepare_roster_swap").handler(
      {
        person: "SN-Priya",
        dates: ["2026-10-08"],
        reason: "sick_or_emergency",
        partner: "SN-Kai",
        summary: "Priya is on MC.",
      },
      {},
    );
    expect(answer).toMatch(/Step 1 still has options: SN-Joy\./);
    expect(answer).toMatch(/No overtime request was prepared/);
    expect(fixture.prepare).not.toHaveBeenCalled();
    expect(useAssistantStore.getState().activeRosterChange).toBeNull();
  });

  it("refuses a borrow card when the host asked no lending-ward question", async () => {
    useBorrow();
    const answer = await tool("prepare_borrowed_cover").handler(
      { ...BORROW_MEI, summary: "Borrow." },
      {},
    );
    expect(answer).toMatch(/did not ask the lending ward/);
    expect(useAssistantStore.getState().activeRosterChange).toBeNull();
  });

  it("offers run one short only at step 4, with the nurse manager's sign-off", async () => {
    useShort();
    const early = await tool("prepare_roster_swap").handler(
      { person: "SN-Priya", dates: ["2026-10-08"], reason: "swap", summary: "Short." },
      {},
    );
    expect(early).toMatch(/Step 3 still has options/);
    await tool("prepare_roster_swap").handler(
      {
        person: "SN-Priya",
        dates: ["2026-10-08"],
        reason: "swap",
        noTemporaryNurse: true,
        summary: "Nobody is available.",
      },
      {},
    );
    const card = useAssistantStore.getState().activeRosterChange;
    expect(card?.view.stepLabel).toBe("Step 4 · Last resort: run one short");
    expect(card?.view.agreement).toMatch(/^My nurse manager has agreed it is safe/);
  });

  it("refuses to run short when it drops the senior who can be in charge", async () => {
    useShort();
    const found = (await tool("find_swap_partners").handler(
      {
        person: "SSN-Lee",
        dates: ["2026-10-08"],
        reason: "sick_or_emergency",
        noTemporaryNurse: true,
      },
      {},
    )) as { step: number; short: { allowed: boolean; refusal?: string } };
    expect(found.step).toBe(4);
    expect(found.short.allowed).toBe(false);
    expect(found.short.refusal).toMatch(/nurse who can be in charge must stay/);
  });
});

describe("the swap card in the assistant store", () => {
  it("holds the turn open for the user, and a fresh show gets a fresh id", async () => {
    const prepare = () =>
      tool("prepare_roster_swap").handler(
        { ...PRIYA_NIGHTS, partner: "SN-Cara", summary: "Priya needs those nights off." },
        {},
      );
    expect(turnAwaitsUserOnCard(TURN)).toBe(false);
    await prepare();
    const first = useAssistantStore.getState().activeRosterChange?.id;
    expect(turnAwaitsUserOnCard(TURN)).toBe(true);
    expect(turnAwaitsUserOnCard(TURN + 1)).toBe(false);
    await prepare();
    expect(useAssistantStore.getState().activeRosterChange?.id).toBe((first ?? 0) + 1);
    assistantActions.clearRosterChange();
    expect(turnAwaitsUserOnCard(TURN)).toBe(false);
  });
});
