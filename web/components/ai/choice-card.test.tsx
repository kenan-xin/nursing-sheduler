// @vitest-environment jsdom
//
// The option card behind `offer_choices`: a click only SENDS a message, through the same
// path the composer uses. The chat view and the turn session are stubbed exactly as in
// assistant-proposal.test.tsx: the claim is the composition, not the transport.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import {
  AssistantHistoricalConversation,
  AssistantLiveConversation,
} from "./assistant-conversation";
import { choiceParameters, useChoiceTools } from "./use-choice-tools";
import { bindTurnForTest, type TestTurnHandle } from "./turn-authority.test-support";

interface CapturedTool {
  name: string;
  handler: (args: unknown, context: { signal?: AbortSignal }) => Promise<unknown>;
}
const captured = vi.hoisted(() => [] as CapturedTool[]);
const send = vi.hoisted(() => vi.fn());
const session = vi.hoisted(() => ({ isRunning: false }));

vi.mock("@copilotkit/react-core/v2", () => ({
  // A stand-in composer: its one button submits the way the real input does.
  CopilotChatView: ({ onSubmitMessage }: { onSubmitMessage: (value: string) => void }) => (
    <button data-testid="composer-send" onClick={() => onSubmitMessage("typed in composer")}>
      composer
    </button>
  ),
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
    isRunning: session.isRunning,
    interrupting: false,
    send,
    stop: vi.fn(),
  }),
}));

const SINGLE = {
  question: "Which Ana did you mean?",
  options: [
    { label: "Ana Lim", detail: "Ward 3" },
    { label: "Ana Tan", detail: "" },
  ],
  multiple: false,
};
const MULTI = {
  question: "Which shifts should this rule cover?",
  options: [
    { label: "Day", detail: "" },
    { label: "Evening", detail: "" },
    { label: "Night", detail: "" },
  ],
  multiple: true,
};

function renderLive() {
  render(<AssistantLiveConversation threadId="thread-1" routePath="/dates" routeLabel="Dates" />);
}

beforeEach(() => {
  send.mockReset();
  session.isRunning = false;
  assistantActions.resetForTest();
});

afterEach(() => {
  cleanup();
  assistantActions.resetForTest();
});

describe("the option card", () => {
  it("sends exactly the clicked option's label and closes", async () => {
    assistantActions.showChoices(SINGLE);
    renderLive();

    expect(screen.getByRole("group", { name: SINGLE.question })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Ana Tan/ }));

    expect(send).toHaveBeenCalledExactlyOnceWith("Ana Tan");
    expect(screen.queryByRole("group", { name: SINGLE.question })).toBeNull();
  });

  it("multi-select sends the checked labels joined, and not before one is checked", async () => {
    assistantActions.showChoices(MULTI);
    renderLive();

    const sendChecked = screen.getByRole("button", { name: "Send selected" });
    expect(sendChecked).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: "Day" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Night" }));
    await userEvent.click(sendChecked);

    expect(send).toHaveBeenCalledExactlyOnceWith("Day, Night");
    expect(screen.queryByRole("group", { name: MULTI.question })).toBeNull();
  });

  it("sends a typed Other answer, and cannot send an empty one", async () => {
    assistantActions.showChoices(SINGLE);
    renderLive();

    const sendOther = screen.getByRole("button", { name: "Send other answer" });
    expect(sendOther).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Other"), "   ");
    expect(sendOther).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Other"), "Ana from Ward 5");
    await userEvent.click(sendOther);

    expect(send).toHaveBeenCalledExactlyOnceWith("Ana from Ward 5");
    expect(screen.queryByRole("group", { name: SINGLE.question })).toBeNull();
  });

  it("closes when the user sends from the main composer", async () => {
    assistantActions.showChoices(SINGLE);
    renderLive();

    await userEvent.click(screen.getByTestId("composer-send"));

    expect(send).toHaveBeenCalledExactlyOnceWith("typed in composer");
    expect(screen.queryByRole("group", { name: SINGLE.question })).toBeNull();
  });

  it("cannot answer while the turn is still running", () => {
    session.isRunning = true;
    assistantActions.showChoices(SINGLE);
    renderLive();

    expect(screen.getByRole("button", { name: /Ana Tan/ })).toBeDisabled();
  });

  it("Dismiss closes the card without sending", async () => {
    assistantActions.showChoices(SINGLE);
    renderLive();

    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(send).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: SINGLE.question })).toBeNull();
  });

  it("is cleared when the thread or scenario switches", () => {
    assistantActions.showChoices(SINGLE);
    const { rerender } = render(
      <AssistantLiveConversation
        key="thread-1"
        threadId="thread-1"
        routePath="/"
        routeLabel={null}
      />,
    );
    // The panel keys the live conversation by thread, and the thread follows the scenario.
    rerender(
      <AssistantLiveConversation
        key="thread-2"
        threadId="thread-2"
        routePath="/"
        routeLabel={null}
      />,
    );

    expect(useAssistantStore.getState().activeChoices).toBeNull();
    expect(screen.queryByRole("group", { name: SINGLE.question })).toBeNull();
  });

  it("tells duplicate labels apart", async () => {
    assistantActions.showChoices({
      question: "Which Ana?",
      options: [
        { label: "Ana", detail: "Ward 3" },
        { label: "Ana", detail: "Ward 5" },
      ],
      multiple: true,
    });
    renderLive();

    const [first, second] = screen.getAllByRole("checkbox");
    await userEvent.click(first);

    expect(first).toBeChecked();
    expect(second).not.toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Send selected" }));
    expect(send).toHaveBeenCalledExactlyOnceWith("Ana");
  });

  it("does not render in a historical conversation", async () => {
    assistantActions.showChoices(SINGLE);
    render(<AssistantHistoricalConversation threadId="thread-1" reason="Earlier schedule." />);
    await screen.findByTestId("assistant-historical-conversation");

    expect(screen.queryByRole("group", { name: SINGLE.question })).toBeNull();
    expect(screen.queryByRole("button", { name: /Ana Tan/ })).toBeNull();
  });
});

describe("offer_choices", () => {
  const TURN = 4;
  let boundTurn: TestTurnHandle;

  function Host() {
    useChoiceTools("scheduler:thread-1", TURN);
    return null;
  }

  beforeEach(() => {
    captured.length = 0;
    useAssistantStore.setState({ turnEpoch: TURN });
    boundTurn = bindTurnForTest({ turnEpoch: TURN });
  });

  afterEach(() => boundTurn.release());

  it("shows the card, and a second call replaces the first with a fresh state", async () => {
    render(
      <>
        <Host />
        <AssistantLiveConversation threadId="thread-1" routePath="/dates" routeLabel="Dates" />
      </>,
    );
    const tool = captured.find((candidate) => candidate.name === "offer_choices");

    await act(() => tool!.handler(MULTI, {}));
    await userEvent.click(screen.getByRole("checkbox", { name: "Day" }));
    await userEvent.type(screen.getByLabelText("Other"), "half days");
    const NEXT = { ...MULTI, question: "Which shifts should the second rule cover?" };
    await act(() => tool!.handler(NEXT, {}));

    expect(screen.queryByRole("group", { name: MULTI.question })).toBeNull();
    expect(screen.getByRole("group", { name: NEXT.question })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Day" })).not.toBeChecked();
    expect(screen.getByLabelText("Other")).toHaveValue("");
  });

  it("accepts 2 to 5 options and requires multiple", () => {
    const option = { label: "A", detail: "" };
    const offer = (count: number) => ({
      question: "Q",
      options: Array.from({ length: count }, () => option),
      multiple: false,
    });
    expect(choiceParameters.safeParse(offer(2)).success).toBe(true);
    expect(choiceParameters.safeParse(offer(5)).success).toBe(true);
    expect(choiceParameters.safeParse(offer(1)).success).toBe(false);
    expect(choiceParameters.safeParse(offer(6)).success).toBe(false);
    const { multiple: _omitted, ...withoutMultiple } = offer(2);
    expect(choiceParameters.safeParse(withoutMultiple).success).toBe(false);
  });
});
