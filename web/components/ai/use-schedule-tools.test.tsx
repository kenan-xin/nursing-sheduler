// @vitest-environment jsdom
// The past-schedule tools and the "Create May?" card (plq5 P3), over the REAL authority
// and repository: the reads open and write nothing, prepare shows a card and creates
// nothing, and only the card's Create makes the new schedule.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PastRoster } from "@/lib/proposal";
import { createEmptyScenarioUiState, type ScenarioUiState } from "@/lib/scenario";
import {
  createRosterStorageForDb,
  loadScenario,
  scenarioCommands,
  useAuthorityStore,
} from "@/lib/store";
import { installTestAuthority, type TestAuthority } from "@/lib/store/test-authority";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { scheduleRef } from "@/lib/ai/assistant/new-period";
import { NewPeriodCard } from "./new-period-card";
import { useScheduleTools } from "./use-schedule-tools";
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
  useCopilotKit: () => ({ copilotkit: SCOPE }),
}));
const SCOPE = {};

const TURN = 3;
let boundTurn: TestTurnHandle;
let harness: TestAuthority;

const APRIL: ScenarioUiState = {
  ...createEmptyScenarioUiState(),
  meta: { apiVersion: "alpha", description: "Ward 3" },
  rangeStart: "2026-04-01",
  rangeEnd: "2026-04-30",
  staff: [{ id: "ana" }, { id: "bo" }],
  shifts: [{ id: "D" }, { id: "N" }],
  reqData: [{ uid: "l", person: "ana", date: "02", kind: "leave" }],
};

const ROSTER: PastRoster = {
  context: {
    people: [{ id: "ana" }, { id: "bo" }],
    shiftTypes: [{ id: "D" }, { id: "N" }],
    calendar: Array.from({ length: 30 }, (_, i) => ({
      iso: `2026-04-${String(i + 1).padStart(2, "0")}`,
      weekday: "Mon",
      weekend: false,
      holiday: false,
    })),
    baselineMinimums: [],
    leaveCreditMinutes: null,
  },
  solvedDays: [0, 1].map((p) =>
    Array.from({ length: 30 }, (_, d) =>
      d === 29 && p === 0 ? { kind: "shift" as const, shiftId: "N" } : { kind: "off" as const },
    ),
  ),
  edits: [],
};

function Host() {
  useScheduleTools("scheduler:thread-1", TURN);
  return null;
}

function call(name: string, args: unknown = {}) {
  const found = captured.find((tool) => tool.name === name);
  if (!found) throw new Error(`tool "${name}" was never registered`);
  return found.handler(args, {}) as Promise<Record<string, unknown>>;
}

const text = (answer: unknown) => (answer as { guidance: string }).guidance;

let april: string;
let october: string;

beforeEach(async () => {
  captured.length = 0;
  harness = await installTestAuthority();
  expect((await loadScenario(APRIL)).ok).toBe(true);
  april = useAuthorityStore.getState().scenarioId!;
  const roster = createRosterStorageForDb(() => harness.db, april);
  await roster.promoteDocumentToWorking({
    document: ROSTER,
    validate: (document) => ({ ok: true, document }),
    expectedWorkingRevision: null,
    expectedClearEpoch: await roster.getClearEpoch(),
  });
  await loadScenario({ ...APRIL, rangeStart: "2026-10-01", rangeEnd: "2026-10-31", reqData: [] });
  october = useAuthorityStore.getState().scenarioId!;
  useAssistantStore.setState({ turnEpoch: TURN });
  boundTurn = bindTurnForTest({ turnEpoch: TURN });
  render(<Host />);
});

afterEach(() => {
  boundTurn.release();
  cleanup();
  assistantActions.resetForTest();
});

describe("list_recent_schedules", () => {
  it("lists refs, never ids, and marks the open one", async () => {
    const answer = await call("list_recent_schedules");
    const rows = answer.schedules as Record<string, unknown>[];
    expect(rows).toEqual([
      expect.objectContaining({ name: "Ward 3 · October 2026", current: true, hasRoster: false }),
      expect.objectContaining({
        ref: scheduleRef(april),
        name: "Ward 3 · April 2026",
        ward: "Ward 3",
        period: "April 2026",
        current: false,
        hasRoster: true,
      }),
    ]);
    expect(JSON.stringify(answer)).not.toContain(april);
    expect(text(answer)).toMatch(/list_recent_schedules/);
  });
});

describe("get_past_schedule_summary", () => {
  it("reads April and its roster without opening it", async () => {
    const answer = await call("get_past_schedule_summary", { scheduleRef: scheduleRef(april) });
    expect(answer).toMatchObject({
      name: "Ward 3 · April 2026",
      overview: { rosterPeriod: { start: "2026-04-01", end: "2026-04-30" } },
      historyDays: 7,
      nextPeriodStart: "2026-05-01",
      roster: {
        rows: [
          expect.objectContaining({ person: "ana", lastDays: expect.any(Array) }),
          expect.anything(),
        ],
      },
    });
    expect(JSON.stringify(answer)).not.toContain(april);
    expect(useAuthorityStore.getState().scenarioId).toBe(october);
  });

  it("refuses a ref it did not hand out", async () => {
    expect(text(await call("get_past_schedule_summary", { scheduleRef: "sch-0000" }))).toMatch(
      /No schedule has that ref/,
    );
  });
});

describe("prepare_new_period_from_schedule", () => {
  const MAY = { rangeStart: "2026-05-01", rangeEnd: "2026-05-31" };

  it("shows a card and creates nothing", async () => {
    const answer = await call("prepare_new_period_from_schedule", {
      scheduleRef: scheduleRef(april),
      ...MAY,
    });
    expect(text(answer)).toMatch(/Nothing has been created/);
    const card = useAssistantStore.getState().activeNewPeriod;
    expect(card).toMatchObject({
      turnEpoch: TURN,
      request: { sourceScenarioId: april, ...MAY },
      view: { newName: "Ward 3 · May 2026", sourceName: "Ward 3 · April 2026" },
    });
    expect(card!.view.history).toMatch(/last 7 days/);
    expect(card!.view.notCarried).toMatch(/1 leave day/);
    expect(await scenarioCommands.listSchedules()).toHaveLength(2);
    expect(useAuthorityStore.getState().scenarioId).toBe(october);
  });

  it("asks first when no history can be carried, then prepares once the user agrees", async () => {
    const june = {
      scheduleRef: scheduleRef(april),
      rangeStart: "2026-06-01",
      rangeEnd: "2026-06-30",
    };
    expect(text(await call("prepare_new_period_from_schedule", june))).toMatch(
      /No rest history can be carried.*2026-04-30.*offer_choices/,
    );
    expect(useAssistantStore.getState().activeNewPeriod).toBeNull();

    await call("prepare_new_period_from_schedule", { ...june, continueWithoutHistory: true });
    expect(useAssistantStore.getState().activeNewPeriod?.view.history).toMatch(
      /does not follow straight after April 2026/,
    );
  });

  it("passes the range arm's refusal on", async () => {
    const answer = await call("prepare_new_period_from_schedule", {
      scheduleRef: scheduleRef(april),
      rangeStart: "2026-05-31",
      rangeEnd: "2026-05-01",
    });
    expect(text(answer)).toMatch(/end date must be on or after the start date/);
    expect(useAssistantStore.getState().activeNewPeriod).toBeNull();
  });
});

describe("the card", () => {
  async function showMay() {
    await call("prepare_new_period_from_schedule", {
      scheduleRef: scheduleRef(april),
      rangeStart: "2026-05-01",
      rangeEnd: "2026-05-31",
    });
    render(<NewPeriodCard disabled={false} />);
  }

  it("creates and opens May only on the user's Create", async () => {
    await showMay();
    expect(screen.getByText("Create “Ward 3 · May 2026”?")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByTestId("new-period-create"));
    });
    await vi.waitFor(() => expect(useAssistantStore.getState().activeNewPeriod).toBeNull());
    expect(useAuthorityStore.getState()).toMatchObject({ derivedFrom: "Ward 3 · April 2026" });
    expect(await scenarioCommands.listSchedules()).toHaveLength(3);
  });

  it("refuses, and says so, when April changed since the preview", async () => {
    await showMay();
    await scenarioCommands.openSchedule(april);
    await scenarioCommands.mutate({ staff: [...APRIL.staff, { id: "cai" }] });
    await act(async () => {
      fireEvent.click(screen.getByTestId("new-period-create"));
    });
    expect(await screen.findByTestId("new-period-failed")).toHaveTextContent(
      "“Ward 3 · April 2026” changed since this preview, so nothing was created. Ask again.",
    );
    expect(await scenarioCommands.listSchedules()).toHaveLength(2);
  });

  it("shows no Create control once its turn was stopped", async () => {
    await showMay();
    act(() => useAssistantStore.setState({ turnEpoch: TURN + 1 }));
    expect(screen.queryByTestId("new-period-create")).toBeNull();
  });
});
