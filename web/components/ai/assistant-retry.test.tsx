// @vitest-environment jsdom
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  persistThreadMessages,
  recordPreparingTurn,
  selectActiveThread,
  setTurnState,
} from "@/lib/ai/assistant/history-repo";
import type { AssistantSettlement, InterruptionTrigger } from "@/lib/ai/assistant/lifecycle";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { createAssistantHarness, type AssistantHarness } from "@/lib/ai/assistant/test-support";
import { AssistantLiveConversation, LifecycleNotice } from "./assistant-conversation";
import { useAssistantRetry } from "./use-assistant-retry";

// The chat view and the turn session are stubbed exactly as in `choice-card.test.tsx`:
// one wiring test renders the REAL live conversation, so the transport is noise but the
// composition is under test. This is where the retry's option could be dropped -- a
// one-argument adapter is assignable to `session.send`, so only a real render catches it.
interface CapturedTool {
  name: string;
  handler: (args: unknown, context: { signal?: AbortSignal }) => Promise<unknown>;
}
const captured = vi.hoisted(() => [] as CapturedTool[]);
const sessionSend = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@copilotkit/react-core/v2", () => ({
  CopilotChatView: ({
    onSubmitMessage,
    input: Input,
  }: {
    onSubmitMessage: (value: string) => void;
    input?: ComponentType<{ onSubmitMessage: (value: string) => void }>;
  }) => (
    <div>
      <div data-testid="transcript-stub" />
      {Input ? <Input onSubmitMessage={onSubmitMessage} /> : null}
    </div>
  ),
  CopilotChatInput: () => <div data-testid="composer-stub" />,
  CopilotChatMessageView: () => <div data-testid="chat-message-view-stub" />,
  useFrontendTool: (definition: CapturedTool) => {
    if (!captured.some((tool) => tool.name === definition.name)) captured.push(definition);
  },
  useCopilotKit: () => ({ copilotkit: SCOPE }),
}));
const SCOPE = {};
vi.mock("next/navigation", () => ({
  usePathname: () => "/dates",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("./use-assistant-session", () => ({
  useAssistantSession: () => ({
    messages: [],
    isRunning: false,
    interrupting: false,
    sending: false,
    send: sessionSend,
    stop: vi.fn(),
  }),
}));

// A ONE-CLICK RETRY FOR A FAILED TURN (bead 2by.8).
//
// v2 already told the user "Send again to retry" and offered nothing to press. The
// control is not a second send path: it replays the failed turn's OWN question
// through the conversation's ordinary `send`, carrying the failed turn's id so the
// send-gate replaces that turn instead of asking the same thing twice.
//
// The question is read from DURABLE history, never from the visible list, so a turn
// that failed before its question was written cannot resend some earlier message.

let harness: AssistantHarness;
let threadId: string;

beforeEach(async () => {
  harness = createAssistantHarness();
  assistantActions.resetForTest();
  sessionSend.mockClear();
  const thread = await selectActiveThread("scenario-a", harness.config);
  threadId = thread.threadId;
});

afterEach(() => {
  cleanup();
  assistantActions.resetForTest();
});

/** A settled turn that left `question` behind -- the row a retry must replace. */
async function seedSettledTurn(
  question: string | null,
  settlement: AssistantSettlement,
  trigger: InterruptionTrigger | null = null,
) {
  const turn = await recordPreparingTurn(
    {
      threadId,
      scenarioId: "scenario-a",
      basisDocumentRevision: 3,
      leaseEpoch: 1,
      modelId: "anthropic/claude-sonnet-4.5",
      runId: "run-1",
      turnEpoch: 1,
      runtimeInstanceId: "instance-1",
    },
    harness.config,
  );
  if (!turn) throw new Error("expected a live thread to accept a preparing turn");
  if (question !== null) {
    await persistThreadMessages(
      [{ id: "m-question", role: "user", content: question }],
      {
        threadId,
        scenarioId: "scenario-a",
        modelId: "anthropic/claude-sonnet-4.5",
        turnId: turn.turnId,
        globalGeneration: turn.globalGeneration,
        scenarioGeneration: turn.scenarioGeneration,
        createdAt: harness.now().toISOString(),
      },
      harness.config,
    );
  }
  await setTurnState(turn.turnId, { state: "detached", settlement, trigger }, harness.config);
  return turn;
}

function settle(settlement: AssistantSettlement, trigger: InterruptionTrigger | null = null) {
  useAssistantStore.setState({ lastSettlement: { trigger, settlement } });
}

type Send = (text: string, options?: { replaceTurnId?: string }) => Promise<boolean>;

/**
 * The live conversation's two pieces: the retry controller, and the notice it feeds.
 *
 * `data-checking` is the controller's own word on whether its durable lookup for the
 * last settled turn has finished. It is what makes a NEGATIVE assertion mean
 * something: "no Retry control" has to be read after the lookup answered, not while
 * it is still running.
 */
function Host({ send }: { send: Send }) {
  const retry = useAssistantRetry({ threadId, send, busy: false });
  return (
    <div data-testid="retry-host" data-checking={retry.checking ? "yes" : "no"}>
      <LifecycleNotice onRetry={retry.canRetry ? retry.retry : null} />
    </div>
  );
}

/** Wait until the retry controller has answered for the settlement on screen. */
async function scanned() {
  await waitFor(() =>
    expect(screen.getByTestId("retry-host")).toHaveAttribute("data-checking", "no"),
  );
}

describe("the failed turn's Retry control", () => {
  it("shows nothing a host does not offer, however the turn ended", () => {
    settle("run_failed");
    render(<LifecycleNotice />);

    expect(screen.getByTestId("assistant-settlement")).toBeInTheDocument();
    expect(screen.queryByTestId("assistant-retry")).toBeNull();
  });

  it("offers Retry once a failed turn is behind it, and sends its question back with its id", async () => {
    await seedSettledTurn("and the 16th?", "run_failed");
    settle("run_failed");
    const send = vi.fn<Send>(async () => true);
    render(<Host send={send} />);

    const retry = await screen.findByTestId("assistant-retry");
    await userEvent.click(retry);

    expect(send).toHaveBeenCalledTimes(1);
    // The same message, and the identity of the turn it replaces -- which is what
    // stops the gate asking the question twice.
    expect(send.mock.calls[0][0]).toBe("and the 16th?");
    expect(send.mock.calls[0][1]).toEqual({ replaceTurnId: expect.any(String) });
  });

  it("offers Retry for a turn an interruption stopped, not only for a failure", async () => {
    await seedSettledTurn("and the 16th?", "stopped", "stop");
    settle("stopped", "stop");
    render(<Host send={vi.fn(async () => true)} />);

    expect(await screen.findByTestId("assistant-retry")).toBeInTheDocument();
  });

  it("does not offer Retry for a turn that answered", async () => {
    await seedSettledTurn("and the 16th?", "completed");
    settle("completed");
    render(<Host send={vi.fn(async () => true)} />);

    await scanned();
    expect(screen.queryByTestId("assistant-retry")).toBeNull();
  });

  it("does not offer Retry for a turn that left no question to resend", async () => {
    await seedSettledTurn(null, "run_failed");
    settle("run_failed");
    render(<Host send={vi.fn(async () => true)} />);

    // The turn failed before its question was ever written, so there is nothing to
    // send again -- and a control that promised otherwise would be a lie.
    await scanned();
    expect(screen.queryByTestId("assistant-retry")).toBeNull();
  });

  it("closes the control once the retry is on its way, so it cannot be fired twice", async () => {
    await seedSettledTurn("and the 16th?", "run_failed");
    settle("run_failed");
    let release: (accepted: boolean) => void = () => {};
    const send = vi.fn(() => new Promise<boolean>((resolve) => (release = resolve)));
    render(<Host send={send} />);

    await userEvent.click(await screen.findByTestId("assistant-retry"));

    expect(screen.queryByTestId("assistant-retry")).toBeNull();
    release(true);
  });
});

describe("the retry the live conversation wires up", () => {
  it("hands the failed turn's question and id to the session's OWN send, unwrapped", async () => {
    const turn = await seedSettledTurn("and the 16th?", "run_failed");
    settle("run_failed");
    render(<AssistantLiveConversation threadId={threadId} routePath="/dates" routeLabel="Dates" />);

    await userEvent.click(await screen.findByTestId("assistant-retry"));

    // The regression this test exists for: the panel's send path is an adapter that
    // takes only the text, so a retry routed through it would arrive at the gate with
    // no `replaceTurnId` -- and the user's question would be asked a second time. Type
    // checking cannot see it (a one-argument function is assignable), so it is pinned
    // here against the real composition: the session's own send, option intact.
    expect(sessionSend).toHaveBeenCalledExactlyOnceWith("and the 16th?", {
      replaceTurnId: turn.turnId,
    });
  });
});
