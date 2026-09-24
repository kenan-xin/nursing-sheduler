// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Observable } from "rxjs";
import { AbstractAgent, type BaseEvent, type RunAgentInput } from "@copilotkit/react-core/v2";

// The launcher's two icon-only states, and the dock that keeps working while closed.
//
// The badge half drives the store directly: the launcher reads nothing else. The
// keep-alive half mounts the SHIPPED surface under a real provider with only `useAgent`
// seamed (as in session-real-core.test.tsx), so a close really is the product's close.

import { useAuthorityStore } from "@/lib/store";
import { assistantActions, hydrateAssistant, useAssistantStore } from "@/lib/ai/assistant/store";
import { resetRuntimeInstanceForTest } from "@/lib/ai/assistant/runtime-stop";
import { createEmptyScenarioUiState } from "@/lib/scenario";
import {
  SENTINEL_KEY,
  TEST_MODEL,
  createAssistantHarness,
  type AssistantHarness,
} from "@/lib/ai/assistant/test-support";
import type { WriterContext } from "@/lib/ai/assistant/writer-context";
import { AssistantLauncher, formatAttentionCount } from "./assistant-launcher";
import { AssistantSurface } from "./assistant-surface";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const AGENT_ID = "scheduler:thread";
const SCENARIO_ID = "scenario-a";
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
vi.mock("@copilotkit/react-core/v2", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useAgent: () => ({ agent: realAgent.current, isReady: true }) };
});

/** Streams an answer that stops mid-message until the test releases it. */
class HeldAgent extends AbstractAgent {
  static release: () => void = () => {};
  aborted = 0;

  constructor() {
    super({ agentId: AGENT_ID, threadId: "thread-1" });
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    const messageId = `${input.runId}-answer`;
    return new Observable<BaseEvent>((subscriber) => {
      const emit = (event: unknown) => subscriber.next(event as BaseEvent);
      emit({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId });
      emit({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
      HeldAgent.release = () => {
        emit({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: "Two nurses are on leave." });
        emit({ type: "TEXT_MESSAGE_END", messageId });
        emit({ type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId });
        subscriber.complete();
      };
    });
  }

  override abortRun(): void {
    this.aborted += 1;
    super.abortRun();
  }

  override clone(): HeldAgent {
    const copy = new HeldAgent();
    copy.threadId = this.threadId;
    copy.setMessages([...this.messages]);
    clones.push(copy);
    return copy;
  }
}
const clones: HeldAgent[] = [];

const CHOICES = {
  question: "Which Ana did you mean?",
  options: [
    { label: "Ana Lim", detail: "" },
    { label: "Ana Tan", detail: "" },
  ],
  multiple: false,
};

let harness: AssistantHarness;

beforeEach(async () => {
  harness = createAssistantHarness();
  assistantActions.resetForTest();
  resetRuntimeInstanceForTest();
  clones.length = 0;
  realAgent.current = new HeldAgent();
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
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
});

afterEach(() => {
  HeldAgent.release();
  cleanup();
  vi.restoreAllMocks();
});

const launcher = () => screen.getByTestId("assistant-launcher");
const badge = () => screen.queryByTestId("assistant-launcher-badge");
const working = () => screen.queryByTestId("assistant-launcher-working");

describe("the launcher's attention states", () => {
  const epoch = () => useAssistantStore.getState().turnEpoch;

  it("shows a count of 1 for a pending Preview while the dock is closed", () => {
    render(<AssistantLauncher />);
    act(() => assistantActions.showProposal("proposal-1", epoch()));

    expect(badge()).toHaveTextContent("1");
    expect(launcher()).toHaveAccessibleName("Show assistant, 1 item needs you");
  });

  it("counts every pending item: Preview, run card and option card", () => {
    render(<AssistantLauncher />);
    act(() => {
      assistantActions.showProposal("proposal-1", epoch());
      assistantActions.showChoices(CHOICES);
    });
    expect(badge()).toHaveTextContent("2");
    expect(launcher()).toHaveAccessibleName("Show assistant, 2 items need you");

    act(() => assistantActions.showRunRequest(epoch()));
    expect(badge()).toHaveTextContent("3");
  });

  it("does not count a card from a turn that was since stopped", () => {
    render(<AssistantLauncher />);
    act(() => {
      assistantActions.showProposal("proposal-1", epoch() - 1);
      assistantActions.showRunRequest(epoch() - 1);
    });

    expect(badge()).toBeNull();
    expect(launcher()).toHaveAccessibleName("Show assistant");
  });

  it("caps the visible count at 9+", () => {
    expect(formatAttentionCount(1)).toBe("1");
    expect(formatAttentionCount(9)).toBe("9");
    expect(formatAttentionCount(10)).toBe("9+");
  });

  it("shows the working indicator while a turn runs and the dock is closed", () => {
    render(<AssistantLauncher />);
    act(() => assistantActions.beginTurn("turn-1", epoch()));

    expect(working()).toBeInTheDocument();
    expect(badge()).toBeNull();
    expect(launcher()).toHaveAccessibleName("Show assistant, working");
  });

  it("lets needs-you win over working", () => {
    render(<AssistantLauncher />);
    act(() => {
      assistantActions.beginTurn("turn-1", epoch());
      assistantActions.showChoices(CHOICES);
    });

    expect(badge()).toHaveTextContent("1");
    expect(working()).toBeNull();
    expect(launcher()).toHaveAccessibleName("Show assistant, 1 item needs you");
  });

  it("shows nothing while the dock is open", () => {
    render(<AssistantLauncher />);
    act(() => {
      assistantActions.openPanel();
      assistantActions.beginTurn("turn-1", epoch());
      assistantActions.showChoices(CHOICES);
    });

    expect(badge()).toBeNull();
    expect(working()).toBeNull();
    expect(launcher()).toHaveAccessibleName("Hide assistant");
  });
});

describe("closing the dock does not stop the assistant", () => {
  function renderShell() {
    render(
      <>
        <AssistantLauncher />
        <AssistantSurface />
      </>,
    );
  }

  it("keeps a running turn going and shows its reply on reopen", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(launcher());
    const conversation = await screen.findByTestId("assistant-live-conversation");

    // Send through the shipped path: an option card click is a composer send.
    act(() => assistantActions.showChoices(CHOICES));
    await user.click(await screen.findByRole("button", { name: /Ana Lim/ }));
    await waitFor(() => expect(useAssistantStore.getState().streaming).toBe(true));

    await user.click(launcher());
    expect(launcher()).toHaveAccessibleName("Show assistant, working");
    expect(working()).toBeInTheDocument();
    expect(clones.every((clone) => clone.aborted === 0)).toBe(true);

    act(() => HeldAgent.release());
    await waitFor(() => expect(useAssistantStore.getState().activeTurnId).toBeNull());
    expect(launcher()).toHaveAccessibleName("Show assistant");
    const turn = (await harness.db.assistantTurns.toArray()).at(-1);
    expect(turn?.terminalReason).toBe("completed");

    await user.click(launcher());
    // The same conversation, not a remount.
    expect(screen.getByTestId("assistant-live-conversation")).toBe(conversation);
    await waitFor(() => expect(conversation).toHaveTextContent("Two nurses are on leave."));
  });

  it("keeps an option card across close and reopen, but clears it on a thread switch", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(launcher());
    await screen.findByTestId("assistant-live-conversation");
    act(() => assistantActions.showChoices(CHOICES));

    await user.click(launcher());
    expect(useAssistantStore.getState().activeChoices).not.toBeNull();
    expect(launcher()).toHaveAccessibleName("Show assistant, 1 item needs you");

    await user.click(launcher());
    expect(await screen.findByTestId("assistant-choices")).toBeVisible();

    act(() => useAuthorityStore.setState({ scenarioId: "scenario-b" }));
    await waitFor(() => expect(useAssistantStore.getState().activeChoices).toBeNull());
  });
});
