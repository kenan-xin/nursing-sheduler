// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { useRosterChangeStore } from "@/lib/roster/change-request";
import { RosterChangeCard } from "./roster-change-card";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("./use-capability-navigation", () => ({ useCapabilityNavigation: () => navigate }));

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
      { person: "SN-Priya", date: "8 Oct", now: "N", after: "OFF" },
      { person: "SN-Cara", date: "8 Oct", now: "OFF", after: "N" },
    ],
    worthKnowing: ["SN-Cara asked not to have N on 8 Oct."],
    notChecked: [],
  },
};

const onSend = vi.fn();
const renderCard = () => render(<RosterChangeCard onSend={onSend} disabled={false} />);

beforeEach(() => {
  navigate.mockReset();
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
    expect(screen.getByText("SN-Cara asked not to have N on 8 Oct.")).toBeInTheDocument();
  });

  it("opens the Roster screen, hands it the request, and goes away on Apply", async () => {
    assistantActions.showRosterChange(CHANGE, TURN);
    renderCard();
    await userEvent.click(screen.getByTestId("roster-change-apply"));
    await waitFor(() => expect(useRosterChangeStore.getState().pending).not.toBeNull());
    expect(navigate).toHaveBeenCalledWith("roster-viewer");
    expect(useAssistantStore.getState().activeRosterChange).toBeNull();
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

  it("waits for a running turn before Apply", () => {
    assistantActions.showRosterChange(CHANGE, TURN);
    render(<RosterChangeCard onSend={onSend} disabled />);
    expect(screen.getByTestId("roster-change-apply")).toBeDisabled();
    expect(screen.getByTestId("roster-change-cancel")).toBeEnabled();
  });
});
