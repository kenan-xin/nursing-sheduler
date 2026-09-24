// @vitest-environment jsdom
//
// The option card behind `offer_choices`: a click only SENDS a message, through the same
// path the composer uses. The chat view and the turn session are stubbed exactly as in
// assistant-proposal.test.tsx: the claim is the composition, not the transport.

import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import {
  AssistantHistoricalConversation,
  AssistantLiveConversation,
} from "./assistant-conversation";
import { choiceParameters, useChoiceTools } from "./use-choice-tools";
import { describeAnswers } from "./choice-card";
import { bindTurnForTest, type TestTurnHandle } from "./turn-authority.test-support";

interface CapturedTool {
  name: string;
  handler: (args: unknown, context: { signal?: AbortSignal }) => Promise<unknown>;
}
const captured = vi.hoisted(() => [] as CapturedTool[]);
const send = vi.hoisted(() => vi.fn());
const session = vi.hoisted(() => ({ isRunning: false }));

vi.mock("@copilotkit/react-core/v2", () => ({
  // A stand-in view: a transcript, then whatever the `input` slot renders, exactly
  // where the real view puts its composer.
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
  // A stand-in composer: its one button submits the way the real input does.
  CopilotChatInput: ({
    onSubmitMessage,
    textArea,
    disclaimer: Disclaimer,
  }: {
    onSubmitMessage: (value: string) => void;
    textArea?: { placeholder?: string };
    disclaimer?: ComponentType;
  }) => (
    <>
      <button
        data-testid="composer-send"
        data-placeholder={textArea?.placeholder ?? ""}
        onClick={() => onSubmitMessage("typed in composer")}
      >
        composer
      </button>
      {typeof Disclaimer === "function" ? <Disclaimer /> : null}
    </>
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
    assistantActions.showChoices(SINGLE, 1);
    renderLive();

    expect(screen.getByRole("group", { name: SINGLE.question })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Ana Tan/ }));

    expect(send).toHaveBeenCalledExactlyOnceWith("Ana Tan");
    expect(screen.queryByRole("group", { name: SINGLE.question })).toBeNull();
  });

  it("multi-select sends the checked labels in option order, and not before one is checked", async () => {
    assistantActions.showChoices(MULTI, 1);
    renderLive();

    const sendChecked = screen.getByRole("button", { name: "Send selected" });
    expect(sendChecked).toBeDisabled();
    // Clicked out of order: the message still follows the options.
    await userEvent.click(screen.getByRole("checkbox", { name: "Night" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Day" }));
    expect(screen.getByRole("checkbox", { name: "Day" })).toBeChecked();
    await userEvent.click(sendChecked);

    expect(send).toHaveBeenCalledExactlyOnceWith("Day, Night");
    expect(screen.queryByRole("group", { name: MULTI.question })).toBeNull();
  });

  it("sends a typed Something else answer, and offers no Send for an empty one", async () => {
    assistantActions.showChoices(SINGLE, 1);
    renderLive();

    const sendOther = () => screen.queryByRole("button", { name: "Send other answer" });
    expect(sendOther()).toBeNull();
    // An empty row offers Skip instead.
    expect(screen.getByRole("button", { name: "Skip" })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Something else"), "   ");
    expect(sendOther()).toBeNull();
    await userEvent.type(screen.getByLabelText("Something else"), "Ana from Ward 5");
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    await userEvent.click(sendOther()!);

    expect(send).toHaveBeenCalledExactlyOnceWith("Ana from Ward 5");
    expect(screen.queryByRole("group", { name: SINGLE.question })).toBeNull();
  });

  it("closes when the user sends from the main composer", async () => {
    assistantActions.showChoices(SINGLE, 1);
    renderLive();

    await userEvent.click(screen.getByTestId("composer-send"));

    expect(send).toHaveBeenCalledExactlyOnceWith("typed in composer");
    expect(screen.queryByRole("group", { name: SINGLE.question })).toBeNull();
  });

  it("cannot answer while the turn is still running", () => {
    session.isRunning = true;
    assistantActions.showChoices(SINGLE, 1);
    renderLive();

    expect(screen.getByRole("button", { name: /Ana Tan/ })).toBeDisabled();
  });

  it("Close and Skip each close the card without sending", async () => {
    for (const name of ["Close", "Skip"]) {
      assistantActions.showChoices(SINGLE, 1);
      const { unmount } = render(
        <AssistantLiveConversation threadId="thread-1" routePath="/dates" routeLabel="Dates" />,
      );

      await userEvent.click(screen.getByRole("button", { name }));

      expect(send).not.toHaveBeenCalled();
      expect(screen.queryByRole("group", { name: SINGLE.question })).toBeNull();
      unmount();
    }
  });

  it("is cleared when the thread or scenario switches", () => {
    assistantActions.showChoices(SINGLE, 1);
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
    assistantActions.showChoices(
      {
        question: "Which Ana?",
        options: [
          { label: "Ana", detail: "Ward 3" },
          { label: "Ana", detail: "Ward 5" },
        ],
        multiple: true,
      },
      1,
    );
    renderLive();

    const [first, second] = screen.getAllByRole("checkbox");
    await userEvent.click(first);

    expect(first).toBeChecked();
    expect(second).not.toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Send selected" }));
    expect(send).toHaveBeenCalledExactlyOnceWith("Ana");
  });

  it("does not render in a historical conversation", async () => {
    assistantActions.showChoices(SINGLE, 1);
    render(<AssistantHistoricalConversation threadId="thread-1" reason="Earlier schedule." />);
    await screen.findByTestId("assistant-historical-conversation");

    expect(screen.queryByRole("group", { name: SINGLE.question })).toBeNull();
    expect(screen.queryByRole("button", { name: /Ana Tan/ })).toBeNull();
  });
});

describe("the dock", () => {
  it("sits below the transcript and directly above the composer", () => {
    assistantActions.showChoices(SINGLE, 1);
    renderLive();

    const dock = screen.getByTestId("assistant-card-dock");
    expect(dock).toContainElement(screen.getByRole("group", { name: SINGLE.question }));
    const transcript = screen.getByTestId("transcript-stub");
    const composer = screen.getByTestId("composer-send");
    expect(
      transcript.compareDocumentPosition(dock) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(dock.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("changes the composer's placeholder and shows the key hint only while a card is open", async () => {
    renderLive();
    expect(screen.getByTestId("composer-send")).toHaveAttribute("data-placeholder", "");
    expect(screen.queryByTestId("assistant-dock-hint")).toBeNull();

    act(() => assistantActions.showChoices(SINGLE, 1));
    expect(screen.getByTestId("composer-send")).toHaveAttribute(
      "data-placeholder",
      "Or reply directly\u2026",
    );
    expect(screen.getByTestId("assistant-dock-hint")).toHaveTextContent("Enter to pick");

    await userEvent.click(screen.getByRole("button", { name: /Ana Tan/ }));
    expect(screen.queryByTestId("assistant-dock-hint")).toBeNull();
  });
});

describe("the option card's keys", () => {
  it("takes focus when it appears; Down then Enter picks the second option", async () => {
    assistantActions.showChoices(SINGLE, 1);
    renderLive();

    expect(screen.getByRole("button", { name: /Ana Lim/ })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{Enter}");

    expect(send).toHaveBeenCalledExactlyOnceWith("Ana Tan");
  });

  it("a number key picks that option directly", async () => {
    assistantActions.showChoices(SINGLE, 1);
    renderLive();

    await userEvent.keyboard("2");

    expect(send).toHaveBeenCalledExactlyOnceWith("Ana Tan");
  });

  it("Esc closes the card and sends nothing", async () => {
    assistantActions.showChoices(SINGLE, 1);
    renderLive();

    await userEvent.keyboard("{Escape}");

    expect(send).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: SINGLE.question })).toBeNull();
  });
});

describe("several questions on one card", () => {
  const PAGED = {
    question: "Add public holidays?",
    options: [
      { label: "Yes, add them", detail: "" },
      { label: "No", detail: "" },
    ],
    multiple: false,
    moreQuestions: [
      {
        question: "Meal break on a 12-hour shift?",
        options: [
          { label: "1 hour, unpaid", detail: "" },
          { label: "45 minutes, unpaid", detail: "" },
        ],
        multiple: false,
      },
      {
        question: "Who can be in charge?",
        options: [
          { label: "Senior Staff Nurses only", detail: "" },
          { label: "Any Staff Nurse", detail: "" },
        ],
        multiple: false,
      },
    ],
  };

  it("asks one at a time, lets an earlier answer change, then sends one message", async () => {
    assistantActions.showChoices(PAGED, 1);
    renderLive();

    expect(screen.getByText("1 of 3")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Yes, add them" }));
    expect(screen.getByRole("group", { name: "Meal break on a 12-hour shift?" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "1 hour, unpaid" }));
    expect(screen.getByText("3 of 3")).toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();

    // Back to the second question, and a different answer.
    await userEvent.click(screen.getByRole("button", { name: "Previous question" }));
    expect(screen.getByText("2 of 3")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "45 minutes, unpaid" }));
    await userEvent.click(screen.getByRole("button", { name: "Any Staff Nurse" }));

    expect(send).toHaveBeenCalledExactlyOnceWith(
      "Add public holidays? Yes, add them\n" +
        "Meal break on a 12-hour shift? 45 minutes, unpaid\n" +
        "Who can be in charge? Any Staff Nurse",
    );
    expect(screen.queryByTestId("assistant-choices")).toBeNull();
  });

  it("Skip records the question as skipped and moves on", async () => {
    assistantActions.showChoices(PAGED, 1);
    renderLive();

    await userEvent.click(screen.getByRole("button", { name: "Skip" }));
    await userEvent.type(screen.getByLabelText("Something else"), "30 minutes");
    await userEvent.click(screen.getByRole("button", { name: "Send other answer" }));
    await userEvent.keyboard("1");

    expect(send).toHaveBeenCalledExactlyOnceWith(
      describeAnswers(
        [PAGED, ...PAGED.moreQuestions],
        ["skipped", "30 minutes", "Senior Staff Nurses only"],
      ),
    );
    expect(send.mock.calls[0]![0]).toContain("Add public holidays? skipped");
  });

  it("does not go forward past an unanswered question", () => {
    assistantActions.showChoices(PAGED, 1);
    renderLive();

    expect(screen.getByRole("button", { name: "Previous question" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next question" })).toBeDisabled();
  });

  it("a composer send answers the whole card", async () => {
    assistantActions.showChoices(PAGED, 1);
    renderLive();

    await userEvent.click(screen.getByRole("button", { name: "Yes, add them" }));
    await userEvent.click(screen.getByTestId("composer-send"));

    expect(send).toHaveBeenCalledExactlyOnceWith("typed in composer");
    expect(screen.queryByTestId("assistant-choices")).toBeNull();
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
    await userEvent.type(screen.getByLabelText("Something else"), "half days");
    const NEXT = { ...MULTI, question: "Which shifts should the second rule cover?" };
    await act(() => tool!.handler(NEXT, {}));

    expect(screen.queryByRole("group", { name: MULTI.question })).toBeNull();
    expect(screen.getByRole("group", { name: NEXT.question })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Day" })).not.toBeChecked();
    expect(screen.getByLabelText("Something else")).toHaveValue("");
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

  it("takes up to three more questions, and a single question is unchanged", () => {
    const question = {
      question: "Q",
      options: [
        { label: "A", detail: "" },
        { label: "B", detail: "" },
      ],
      multiple: false,
    };
    const more = (count: number) => ({
      ...question,
      moreQuestions: Array.from({ length: count }, () => question),
    });
    expect(choiceParameters.safeParse(question).success).toBe(true);
    expect(choiceParameters.safeParse(more(3)).success).toBe(true);
    expect(choiceParameters.safeParse(more(4)).success).toBe(false);
    expect(
      choiceParameters.safeParse({ ...question, moreQuestions: [{ question: "Q2", options: [] }] })
        .success,
    ).toBe(false);
  });
});
