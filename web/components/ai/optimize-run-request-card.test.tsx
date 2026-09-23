// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useHotStore } from "@/lib/store";
import { INITIAL_OPTIMIZE_RUN_VIEW } from "@/lib/optimize/run-view";
import { useRunRequestStore } from "@/lib/optimize/run-request";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { OptimizeRunRequestCard } from "./optimize-run-request-card";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("./use-capability-navigation", () => ({
  useCapabilityNavigation: () => navigate,
}));

const TURN = 3;

beforeEach(() => {
  navigate.mockReset();
  navigate.mockResolvedValue({ status: "focused" });
  useAssistantStore.setState({ turnEpoch: TURN });
  useRunRequestStore.setState({ pending: null, last: null });
  useHotStore.getState().resetRunView();
});

afterEach(() => {
  cleanup();
  assistantActions.resetForTest();
  useHotStore.getState().resetRunView();
});

describe("OptimizeRunRequestCard", () => {
  it("renders nothing when no run was offered", () => {
    const { container } = render(<OptimizeRunRequestCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it("opens the Optimise screen, hands it the request, and goes away on Run", async () => {
    assistantActions.showRunRequest(TURN);
    render(<OptimizeRunRequestCard />);

    await userEvent.click(screen.getByTestId("run-request-run"));

    expect(navigate).toHaveBeenCalledWith("generate-roster");
    await waitFor(() => expect(useRunRequestStore.getState().pending).not.toBeNull());
    expect(useAssistantStore.getState().activeRunRequest).toBeNull();
  });

  it("asks for nothing when the Optimise screen cannot be opened", async () => {
    navigate.mockResolvedValue({ status: "capability_unavailable", reason: "route_not_reached" });
    assistantActions.showRunRequest(TURN);
    render(<OptimizeRunRequestCard />);

    await userEvent.click(screen.getByTestId("run-request-run"));

    expect(await screen.findByTestId("run-request-failed")).toBeInTheDocument();
    expect(useRunRequestStore.getState().pending).toBeNull();
  });

  it("shows a stopped card with no Run control after the turn moved on", () => {
    assistantActions.showRunRequest(TURN);
    useAssistantStore.setState({ turnEpoch: TURN + 1 });
    render(<OptimizeRunRequestCard />);

    expect(screen.getByTestId("assistant-run-request")).toHaveAttribute("data-status", "stopped");
    expect(screen.queryByTestId("run-request-run")).not.toBeInTheDocument();
  });

  it("disables Run while a run is live", () => {
    useHotStore
      .getState()
      .setRunView({ ...INITIAL_OPTIMIZE_RUN_VIEW, lifecycle: "running", jobId: "opt_1" });
    assistantActions.showRunRequest(TURN);
    render(<OptimizeRunRequestCard />);

    expect(screen.getByTestId("run-request-run")).toBeDisabled();
    expect(screen.getByTestId("run-request-live")).toBeInTheDocument();
  });

  it("dismisses on Not now without asking for a run", async () => {
    assistantActions.showRunRequest(TURN);
    render(<OptimizeRunRequestCard />);

    await userEvent.click(screen.getByTestId("run-request-dismiss"));

    expect(useAssistantStore.getState().activeRunRequest).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    expect(useRunRequestStore.getState().pending).toBeNull();
  });
});
