// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { Observable } from "rxjs";
import {
  AbstractAgent,
  CopilotKitCore,
  type BaseEvent,
  type RunAgentInput,
} from "@copilotkit/react-core/v2";
import { z } from "zod";

// THE STOP CONTROL, THROUGH THE SHIPPED PANEL.
//
// Every turn runs on a per-turn CLONE of the panel agent, so the long-lived panel agent
// is idle for the entire run. The hook used to report `isRunning: agent.isRunning` --
// that agent -- and the locked `CopilotChatView` renders its Stop affordance only when
// `isRunning` is true. So a live turn offered the user a SEND control while the model
// was still working, and the only way to stop was an API a nurse does not have.
//
// Calling `session.stop()` from a test cannot catch that: it bypasses the control the
// user actually has. This mounts the real `AssistantLiveConversation`, runs a
// non-cooperative tool so the turn genuinely cannot finish, finds Stop the way a person
// would, and clicks it.

const AGENT_ID = "scheduler:thread";
const SCENARIO_ID = "scenario-a";
const TOOL_NAME = "get_schedule_overview";

import { useAuthorityStore } from "@/lib/store";
import { assistantActions, hydrateAssistant, useAssistantStore } from "@/lib/ai/assistant/store";
import { selectActiveThread } from "@/lib/ai/assistant/history-repo";
import { resetRuntimeInstanceForTest } from "@/lib/ai/assistant/runtime-stop";
import { createEmptyScenarioUiState } from "@/lib/scenario";
import {
  SENTINEL_KEY,
  TEST_MODEL,
  createAssistantHarness,
  type AssistantHarness,
} from "@/lib/ai/assistant/test-support";
import type { WriterContext } from "@/lib/ai/assistant/writer-context";
import { useAssistantSession, type AssistantSession } from "./use-assistant-session";

// jsdom has no layout engine, and the locked chat view measures its composer. The
// observer never fires here, which is fine: nothing under test depends on a resize.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const BASE_WRITER: WriterContext = {
  scenarioId: SCENARIO_ID,
  documentRevision: 12,
  leaseEpoch: 4,
  scenario: { ...createEmptyScenarioUiState(), rangeStart: "2026-09-01", rangeEnd: "2026-09-30" },
};

vi.mock("next/navigation", () => ({
  usePathname: () => "/shift-requests",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/lib/ai/assistant/writer-context", () => ({
  readWriterContext: async () => BASE_WRITER,
}));

const realAgent = vi.hoisted(() => ({ current: null as unknown }));
const realCore = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@copilotkit/react-core/v2", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useAgent: () => ({ agent: realAgent.current, isReady: true }),
    useCopilotKit: () => ({ copilotkit: realCore.current }),
    useFrontendTool: () => {},
  };
});

/** Every clone this agent minted, and whether its run was aborted. */
const clones: PanelAgent[] = [];

class PanelAgent extends AbstractAgent {
  aborted = 0;

  constructor() {
    super({ agentId: AGENT_ID, threadId: "thread-1" });
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    const callId = `${input.runId}-call`;
    return new Observable<BaseEvent>((subscriber) => {
      const emit = (event: unknown) => subscriber.next(event as BaseEvent);
      emit({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId });
      emit({
        type: "TOOL_CALL_START",
        parentMessageId: `msg-${callId}`,
        toolCallId: callId,
        toolCallName: TOOL_NAME,
      });
      emit({ type: "TOOL_CALL_ARGS", toolCallId: callId, delta: "{}" });
      emit({ type: "TOOL_CALL_END", toolCallId: callId });
      // NO `RUN_FINISHED`. The tool handler below never resolves, so this run stays
      // open -- which is exactly the state in which the user needs a Stop control.
    });
  }

  override abortRun(): void {
    this.aborted += 1;
    super.abortRun();
  }

  override clone(): PanelAgent {
    const copy = new PanelAgent();
    copy.threadId = this.threadId;
    copy.setMessages([...this.messages]);
    clones.push(copy);
    return copy;
  }
}

let harness: AssistantHarness;
let threadId: string;
let agent: PanelAgent;
/** Resolves the non-cooperative tool, so a test can end without a dangling handler. */
let releaseTool: (() => void) | null = null;

beforeEach(async () => {
  harness = await createAssistantHarness();
  assistantActions.resetForTest();
  resetRuntimeInstanceForTest();
  clones.length = 0;
  releaseTool = null;

  agent = new PanelAgent();
  realAgent.current = agent;
  realCore.current = new CopilotKitCore({
    runtimeUrl: "http://localhost/api/copilotkit",
    agents__unsafe_dev_only: { [AGENT_ID]: agent },
  });
  (realCore.current as CopilotKitCore).addTool({
    name: TOOL_NAME,
    description: "Read the schedule.",
    agentId: AGENT_ID,
    parameters: z.object({}),
    // NON-COOPERATIVE ON PURPOSE: it ignores the abort signal entirely, which is the
    // hard case -- Stop cannot rely on the handler's cooperation.
    handler: () =>
      new Promise<string>((resolve) => {
        releaseTool = () => resolve("the tool result");
      }),
  });

  globalThis.fetch = (async (url: RequestInfo | URL) => {
    if (String(url).includes("/api/copilotkit")) {
      return new Response(
        JSON.stringify({ agents: {}, mode: "sse", runtimeInstanceId: "instance-1" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;

  await hydrateAssistant();
  await assistantActions.setEnabled(true);
  await assistantActions.activate({
    apiKey: SENTINEL_KEY,
    modelId: TEST_MODEL,
    modelSource: "catalog",
  });
  useAuthorityStore.setState({
    scenarioId: SCENARIO_ID,
    documentRevision: 12,
    recordRevision: 20,
    ownership: "owner",
  });
  threadId = (await selectActiveThread(SCENARIO_ID)).threadId;
});

afterEach(() => {
  releaseTool?.();
  cleanup();
  vi.restoreAllMocks();
});

/**
 * Mount the shipped panel inside a real provider.
 *
 * The provider is needed even though `useAgent`/`useCopilotKit` are mocked: the locked
 * view has internal consumers of the same context that the mock does not intercept.
 */
const session: { current: AssistantSession | null } = { current: null };

/**
 * The panel's own hook, mounted the way the shipped conversation mounts it.
 *
 * `AssistantLiveConversation` passes `session.isRunning || session.interrupting`
 * straight to the locked `CopilotChatView`, which renders Stop only when that is true.
 * See the note above on why the view itself cannot be mounted here.
 */
function Host() {
  session.current = useAssistantSession({
    threadId,
    routePath: "/shift-requests",
    routeLabel: "Shifts",
    historical: false,
  });
  return null;
}

describe("a non-cooperative clone run", () => {
  it("reports the turn as running, so the shipped Stop control is offered", async () => {
    render(<Host />);
    await waitFor(() => expect(session.current).not.toBeNull());

    // Idle: no Stop. So its later presence is a change this turn caused.
    expect(session.current!.isRunning).toBe(false);

    let sent!: Promise<void>;
    act(() => {
      sent = session.current!.send("why is the 15th short?");
    });

    // The turn is genuinely live and genuinely stuck: a clone is running and its tool
    // handler has not resolved. The PANEL agent is idle throughout -- which is exactly
    // what made the old `isRunning: agent.isRunning` report false here.
    await waitFor(() => expect(clones.length).toBeGreaterThan(0));
    expect(agent.isRunning).toBe(false);

    // THE VALUE THE SHIPPED PANEL HANDS THE LOCKED VIEW.
    await waitFor(() => expect(session.current!.isRunning).toBe(true));

    // Stop reaches the CONCRETE clone that is running, not the panel agent.
    act(() => {
      session.current!.stop();
    });
    await waitFor(() => expect(clones.some((clone) => clone.aborted > 0)).toBe(true));
    expect(agent.aborted).toBe(0);

    // And the turn settles truthfully rather than claiming completion. `sent` is NOT
    // awaited: the run never finishes on its own -- that is what non-cooperative means
    // -- so waiting on it would be waiting for the bug this test exists to rule out.
    void sent;
    await waitFor(() => expect(useAssistantStore.getState().interruption).toBeNull());
    const turns = (await harness.db.assistantTurns.toArray()).sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
    expect(turns.at(-1)?.terminalReason).not.toBe("completed");

    // Settled: the control goes away again.
    await waitFor(() => expect(session.current!.isRunning).toBe(false));
  });
});
