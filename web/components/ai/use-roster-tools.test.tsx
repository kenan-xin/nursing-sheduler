// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  assistantActions,
  turnAwaitsUserOnCard,
  useAssistantStore,
} from "@/lib/ai/assistant/store";
import { useRosterChangeStore } from "@/lib/roster/change-request";
import { priyaRosterDocument } from "@/lib/roster-viewer/swap-fixtures";
import { MODEL_VISIBLE_TOOL_SCHEMAS } from "./model-visible-tools";
import {
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

const fixture = vi.hoisted(() => ({ working: null as unknown, pointer: null as unknown }));
vi.mock("@/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store")>();
  return {
    ...actual,
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
  it("registers exactly the three tools", () => {
    expect(captured.map((t) => t.name).sort()).toEqual([
      "find_swap_partners",
      "get_roster",
      "prepare_roster_swap",
    ]);
  });

  it("offers them to the model under the same names and schemas", () => {
    // A tool mounted but missing from this list never reaches the provider, while every
    // other suite stays green. So the list must carry these exact schemas.
    expect(MODEL_VISIBLE_TOOL_SCHEMAS.get_roster).toBe(rosterReadParameters);
    expect(MODEL_VISIBLE_TOOL_SCHEMAS.find_swap_partners).toBe(swapPartnerParameters);
    expect(MODEL_VISIBLE_TOOL_SCHEMAS.prepare_roster_swap).toBe(swapPrepareParameters);
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
