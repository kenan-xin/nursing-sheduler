// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { useRosterChangeStore } from "@/lib/roster/change-request";
import { RosterChangeCard } from "./roster-change-card";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("./use-capability-navigation", () => ({ useCapabilityNavigation: () => navigate }));
const applyLinked = vi.hoisted(() => vi.fn());
vi.mock("./linked-apply", () => ({
  applyLinkedChange: applyLinked,
  linkedApplyDeps: () => ({}),
}));
const confirm = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const cancel = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("@/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store")>();
  return {
    ...actual,
    assistantProposalCommands: {
      ...actual.assistantProposalCommands,
      confirm,
      withdrawConfirmation: vi.fn(),
      cancel,
    },
  };
});

const TURN = 4;
const CHANGE = {
  request: {
    solvedBaselineId: "a".repeat(64),
    cells: [
      {
        personIdx: 0,
        dateIdx: 1,
        before: { kind: "shift", shiftId: "N" } as const,
        after: { kind: "off" } as const,
      },
    ],
  },
  view: {
    heading: "Swap shifts?",
    stepLabel: "Step 1 · Swap or cover within the ward",
    leaveRows: [],
    notes: [],
    agreement: null,
    title: "SN-Priya and SN-Cara, 8 Oct",
    summary: "Priya needs that night off.",
    rows: [
      { person: "SN-Priya", date: "8 Oct", now: "Night", after: "Day off" },
      { person: "SN-Cara", date: "8 Oct", now: "Day off", after: "Night" },
    ],
    worthKnowing: ["SN-Cara asked not to have a night shift on 8 Oct."],
    notChecked: [],
  },
};

const onSend = vi.fn();
const renderCard = () => render(<RosterChangeCard onSend={onSend} disabled={false} />);

beforeEach(() => {
  navigate.mockReset();
  confirm.mockClear();
  confirm.mockResolvedValue({ ok: true });
  cancel.mockClear();
  applyLinked.mockReset();
  navigate.mockResolvedValue({ status: "focused" });
  onSend.mockReset();
  useAssistantStore.setState({ turnEpoch: TURN });
  useRosterChangeStore.setState({ pending: null, last: null });
});
afterEach(() => {
  cleanup();
  assistantActions.resetForTest();
});

describe("RosterChangeCard", () => {
  it("renders nothing when no swap was prepared", () => {
    const { container } = renderCard();
    expect(container).toBeEmptyDOMElement();
  });

  it("shows every changed cell and the soft notes", () => {
    assistantActions.showRosterChange(CHANGE, TURN);
    renderCard();
    expect(screen.getByText("SN-Priya and SN-Cara, 8 Oct")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(3); // header + two cells
    expect(
      screen.getByText("SN-Cara asked not to have a night shift on 8 Oct."),
    ).toBeInTheDocument();
    expect(screen.getByText("Step 1 · Swap or cover within the ward")).toBeInTheDocument();
  });

  it("applies an unlinked change through the same path and goes away", async () => {
    applyLinked.mockResolvedValue({ ok: true });
    assistantActions.showRosterChange(CHANGE, TURN);
    renderCard();
    await userEvent.click(screen.getByTestId("roster-change-apply"));
    await waitFor(() => expect(useAssistantStore.getState().activeRosterChange).toBeNull());
    expect(applyLinked).toHaveBeenCalledWith(
      expect.objectContaining({ request: CHANGE.request, linked: null }),
      expect.anything(),
    );
  });

  it("says why when the Roster screen refuses an unlinked change", async () => {
    applyLinked.mockResolvedValue({
      ok: false,
      message: "Nothing was changed: the Roster screen refused the change.",
    });
    assistantActions.showRosterChange(CHANGE, TURN);
    renderCard();
    await userEvent.click(screen.getByTestId("roster-change-apply"));
    expect(
      await screen.findByText("Nothing was changed: the Roster screen refused the change."),
    ).toBeInTheDocument();
  });

  it("says each half is undone in its own place", () => {
    assistantActions.showRosterChange(
      { ...CHANGE, linked: { proposalId: "p-1", assumptionIds: [], record: "leave" as const } },
      TURN,
    );
    renderCard();
    expect(
      screen.getByText(
        /Undo the roster part on the Roster screen and the schedule part from the change list/,
      ),
    ).toBeInTheDocument();
  });

  it("shows a stopped card with no Apply control", () => {
    assistantActions.showRosterChange(CHANGE, TURN - 1);
    renderCard();
    expect(screen.queryByTestId("roster-change-apply")).toBeNull();
    expect(screen.getByText(/This offer has ended/)).toBeInTheDocument();
  });

  it("keeps the roster as it is when the user cancels", async () => {
    assistantActions.showRosterChange(CHANGE, TURN);
    renderCard();
    await userEvent.click(screen.getByTestId("roster-change-cancel"));
    expect(useAssistantStore.getState().activeRosterChange).toBeNull();
    expect(useRosterChangeStore.getState().pending).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("sends what to change as a message and sets the swap aside", async () => {
    assistantActions.showRosterChange(CHANGE, TURN);
    renderCard();
    await userEvent.type(screen.getByLabelText("Tell me what to change"), "Try SN-Eve instead");
    await userEvent.click(screen.getByRole("button", { name: "Send what to change" }));
    expect(onSend).toHaveBeenCalledWith("Try SN-Eve instead");
    expect(useAssistantStore.getState().activeRosterChange).toBeNull();
    expect(useRosterChangeStore.getState().pending).toBeNull();
  });

  const LINKED_CHANGE = {
    ...CHANGE,
    view: {
      ...CHANGE.view,
      heading: "Ask SN-Asha to come in?",
      stepLabel: "Step 2 · Ask someone off or on leave to come in",
      agreement: "SN-Asha agreed to come in on 8–9 Oct and take leave on 11–12 Oct instead.",
    },
    linked: { proposalId: "p-1", assumptionIds: ["a-1"], record: "leave" as const },
  };

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  async function startLinkedApply() {
    const pending = deferred<{ ok: true } | { ok: false; message: string }>();
    applyLinked.mockReturnValue(pending.promise);
    assistantActions.showRosterChange(LINKED_CHANGE, TURN);
    renderCard();
    await userEvent.click(screen.getByRole("checkbox", { name: /SN-Asha agreed/ }));
    await waitFor(() => expect(screen.getByTestId("roster-change-apply")).toBeEnabled());
    await userEvent.click(screen.getByTestId("roster-change-apply"));
    return pending;
  }

  it("keeps Apply off until the agreement is ticked", async () => {
    assistantActions.showRosterChange(LINKED_CHANGE, TURN);
    renderCard();
    expect(screen.getByTestId("roster-change-apply")).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: /SN-Asha agreed/ }));
    await waitFor(() => expect(screen.getByTestId("roster-change-apply")).toBeEnabled());
    expect(confirm).toHaveBeenCalledWith({ proposalId: "p-1", assumptionId: "a-1" });
    expect(screen.getByText("Step 2 · Ask someone off or on leave to come in")).toBeInTheDocument();
  });

  it.each(["roster-change-revise", "roster-change-cancel"])(
    "cancels the linked schedule change too (%s)",
    async (testId) => {
      assistantActions.showRosterChange(LINKED_CHANGE, TURN);
      renderCard();
      await userEvent.click(screen.getByTestId(testId));
      expect(cancel).toHaveBeenCalledWith("p-1");
      expect(useAssistantStore.getState().activeRosterChange).toBeNull();
    },
  );

  it("cancels the linked schedule change when the user sends what to change", async () => {
    assistantActions.showRosterChange(LINKED_CHANGE, TURN);
    renderCard();
    await userEvent.type(screen.getByLabelText("Tell me what to change"), "Try SN-Eve");
    await userEvent.click(screen.getByRole("button", { name: "Send what to change" }));
    expect(cancel).toHaveBeenCalledWith("p-1");
  });

  it("cancels the linked schedule change of a stopped card", () => {
    assistantActions.showRosterChange(LINKED_CHANGE, TURN - 1);
    renderCard();
    expect(cancel).toHaveBeenCalledWith("p-1");
  });

  it("unticks the agreement when the schedule does not record it", async () => {
    confirm.mockResolvedValue({ ok: false });
    assistantActions.showRosterChange(LINKED_CHANGE, TURN);
    renderCard();
    await userEvent.click(screen.getByRole("checkbox", { name: /SN-Asha agreed/ }));
    await waitFor(() => expect(screen.getByRole("checkbox")).not.toBeChecked());
    expect(screen.getByTestId("roster-change-apply")).toBeDisabled();
  });

  it("locks the card while a linked Apply runs, then shows why it failed", async () => {
    const pending = await startLinkedApply();
    expect(screen.getByTestId("roster-change-revise")).toBeDisabled();
    expect(screen.getByTestId("roster-change-cancel")).toBeDisabled();
    expect(screen.getByLabelText("Tell me what to change")).toBeDisabled();
    // No other card may replace it mid-Apply.
    expect(assistantActions.showRosterChange(CHANGE, TURN)).toBe(false);
    pending.resolve({
      ok: false,
      message: "The leave record was changed, but the roster was not.",
    });
    expect(
      await screen.findByText("The leave record was changed, but the roster was not."),
    ).toBeInTheDocument();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("keeps a failed outcome after the card stops or goes away", async () => {
    const pending = await startLinkedApply();
    act(() => useAssistantStore.setState({ turnEpoch: TURN + 1 }));
    expect(cancel).not.toHaveBeenCalled(); // not mid-Apply
    pending.resolve({ ok: false, message: "Undo it from the change list." });
    expect(await screen.findByText("Undo it from the change list.")).toBeInTheDocument();
    act(() => assistantActions.clearRosterChange());
    expect(screen.getByText("Undo it from the change list.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Undo it from the change list.")).toBeNull();
  });

  it("says so plainly when Apply throws", async () => {
    const pending = await startLinkedApply();
    pending.reject(new Error("idb"));
    expect(await screen.findByText(/Something went wrong while applying/)).toBeInTheDocument();
    expect(useAssistantStore.getState().rosterChangeApplying).toBe(false);
  });

  it("clears the card when the linked Apply succeeds", async () => {
    const pending = await startLinkedApply();
    pending.resolve({ ok: true });
    await waitFor(() => expect(useAssistantStore.getState().activeRosterChange).toBeNull());
    expect(applyLinked).toHaveBeenCalledWith(
      expect.objectContaining({ linked: LINKED_CHANGE.linked }),
      expect.anything(),
    );
  });

  it("waits for a running turn before Apply", () => {
    assistantActions.showRosterChange(CHANGE, TURN);
    render(<RosterChangeCard onSend={onSend} disabled />);
    expect(screen.getByTestId("roster-change-apply")).toBeDisabled();
    expect(screen.getByTestId("roster-change-cancel")).toBeEnabled();
  });

  it("appearing mid-turn, holds focus on the card itself, then moves it to Apply", () => {
    assistantActions.showRosterChange(CHANGE, TURN);
    const { rerender } = render(<RosterChangeCard onSend={onSend} disabled />);
    const card = screen.getByTestId("assistant-roster-change");

    // Never "Change something": a reflexive Enter there would set the change aside.
    expect(card).toHaveFocus();
    expect(screen.getByTestId("roster-change-revise")).not.toHaveFocus();

    rerender(<RosterChangeCard onSend={onSend} disabled={false} />);
    expect(screen.getByTestId("roster-change-apply")).toHaveFocus();
  });
});
