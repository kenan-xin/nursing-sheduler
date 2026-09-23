// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { Observable } from "rxjs";
import {
  AbstractAgent,
  CopilotKitCore,
  type BaseEvent,
  type RunAgentInput,
} from "@copilotkit/react-core/v2";

// WHAT THE USER SEES WHILE A TURN IS LIVE.
//
// Every turn runs on a per-turn CLONE, and the panel renders the long-lived panel agent.
// The clone used to be mirrored only at `TEXT_MESSAGE_END` / `TOOL_CALL_END`, so a reply
// streamed token by token reached the screen in one block at the end, and nothing but an
// unlabeled dot said the assistant was working. These runs stay open on purpose so the
// in-between state is observable.

const AGENT_ID = "scheduler:thread";
const SCENARIO_ID = "scenario-a";
const TOOL_NAME = "get_schedule_overview";

import { useAuthorityStore } from "@/lib/store";
import { assistantActions, hydrateAssistant } from "@/lib/ai/assistant/store";
import { selectActiveThread } from "@/lib/ai/assistant/history-repo";
import { resetRuntimeInstanceForTest } from "@/lib/ai/assistant/runtime-stop";
import { createEmptyScenarioUiState } from "@/lib/scenario";
import { SENTINEL_KEY, TEST_MODEL, createAssistantHarness } from "@/lib/ai/assistant/test-support";
import type { WriterContext } from "@/lib/ai/assistant/writer-context";
import { useAssistantSession, type AssistantSession } from "./use-assistant-session";
import { AssistantActivityStatus } from "./assistant-conversation";

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

type Script = "silent" | "partial-text" | "tool";

class ScriptedAgent extends AbstractAgent {
  constructor(private readonly script: Script) {
    super({ agentId: AGENT_ID, threadId: "thread-1" });
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    const script = this.script;
    return new Observable<BaseEvent>((subscriber) => {
      const emit = (event: unknown) => subscriber.next(event as BaseEvent);
      emit({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId });
      if (script === "partial-text") {
        const messageId = `${input.runId}-reply`;
        emit({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
        emit({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: "The 15th is " });
        emit({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: "short because" });
        // No TEXT_MESSAGE_END: the reply is mid-stream.
      }
      if (script === "tool") {
        const callId = `${input.runId}-call`;
        emit({
          type: "TOOL_CALL_START",
          parentMessageId: `msg-${callId}`,
          toolCallId: callId,
          toolCallName: TOOL_NAME,
        });
        emit({ type: "TOOL_CALL_ARGS", toolCallId: callId, delta: "{}" });
        emit({ type: "TOOL_CALL_END", toolCallId: callId });
      }
      // No RUN_FINISHED: the turn stays live.
    });
  }

  override clone(): ScriptedAgent {
    const copy = new ScriptedAgent(this.script);
    copy.threadId = this.threadId;
    copy.setMessages([...this.messages]);
    return copy;
  }
}

let threadId: string;
const session: { current: AssistantSession | null } = { current: null };

async function setUp(script: Script) {
  await createAssistantHarness();
  assistantActions.resetForTest();
  resetRuntimeInstanceForTest();

  const agent = new ScriptedAgent(script);
  realAgent.current = agent;
  // No tool handler is registered: these runs never finish, so the core never gets as
  // far as executing one, and an unanswered call is exactly the "running" state.
  realCore.current = new CopilotKitCore({
    runtimeUrl: "http://localhost/api/copilotkit",
    agents__unsafe_dev_only: { [AGENT_ID]: agent },
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
}

function Host() {
  session.current = useAssistantSession({
    threadId,
    routePath: "/shift-requests",
    routeLabel: "Shifts",
    historical: false,
  });
  return null;
}

async function sendAndWait() {
  render(<Host />);
  await waitFor(() => expect(session.current).not.toBeNull());
  expect(session.current!.activity).toBeNull();
  act(() => {
    void session.current!.send("why is the 15th short?");
  });
  await waitFor(() => expect(session.current!.isRunning).toBe(true));
}

beforeEach(() => {
  session.current = null;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("a live turn's visible activity", () => {
  it("says it is thinking before the first token or tool event", async () => {
    await setUp("silent");
    await sendAndWait();
    await waitFor(() => expect(session.current!.activity).toEqual({ kind: "thinking" }));
  });

  it("streams partial reply text into the panel before the message ends", async () => {
    await setUp("partial-text");
    await sendAndWait();
    await waitFor(() =>
      expect(
        session.current!.messages.some(
          (message) =>
            message.role === "assistant" && message.content === "The 15th is short because",
        ),
      ).toBe(true),
    );
    // Text on screen is the feedback now; the thinking line steps aside.
    expect(session.current!.activity).toBeNull();
  });

  it("names the tool while one is running", async () => {
    await setUp("tool");
    await sendAndWait();
    await waitFor(() =>
      expect(session.current!.activity).toEqual({ kind: "tool", name: TOOL_NAME }),
    );
  });
});

describe("AssistantActivityStatus", () => {
  it("announces thinking politely", () => {
    render(<AssistantActivityStatus activity={{ kind: "thinking" }} />);
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toContain("Thinking…");
  });

  it("labels a running tool in the user's terms", () => {
    render(<AssistantActivityStatus activity={{ kind: "tool", name: TOOL_NAME }} />);
    expect(screen.getByRole("status").textContent).toContain("Reading your schedule…");
  });

  it("renders nothing when there is no activity", () => {
    const { container } = render(<AssistantActivityStatus activity={null} />);
    expect(container.textContent).toBe("");
  });
});
