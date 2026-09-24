// @vitest-environment jsdom
//
// The Apply notice: navigate to the screen owning most of the change, outline it,
// say so in a live region, and offer the other screens. Navigation is mocked here;
// the real hook is exercised end to end in apply-navigation.integration.test.tsx.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProposalDiff, ProposalDiffEntry, DiffScope } from "@/lib/proposal";
import { CAPABILITY_UNAVAILABLE } from "@/lib/capability/resolve";
import {
  clearChangeHighlight,
  useChangeHighlightStore,
  useChangeTarget,
} from "@/lib/change-highlight/store";
import { useModeStore } from "@/lib/mode/mode";
import { useHotStore } from "@/lib/store";
import { INITIAL_OPTIMIZE_RUN_VIEW } from "@/lib/optimize/run-view";
import type { ApplyOutcomeView, AssistantProposalController } from "./use-assistant-proposals";
import { ApplyNavigationNotice } from "./apply-navigation-notice";

const navigate = vi.fn();
vi.mock("./use-capability-navigation", () => ({ useCapabilityNavigation: () => navigate }));

const entry = (key: string, scope: DiffScope): ProposalDiffEntry => ({
  key,
  scope,
  label: key,
  before: null,
  after: "x",
  kind: "created",
});

const DIFF: ProposalDiff = {
  direct: [
    entry('shift:"EVE"', "shift-types"),
    entry('shift:"LATE"', "shift-types"),
    entry('shift:"N2"', "shift-types"),
    entry('person:"cy"', "staff-list"),
  ],
  cascade: [],
  capabilityIds: ["shift-types", "staff-list"],
  needsReview: [],
};

function controller(outcome: ApplyOutcomeView | null): AssistantProposalController {
  return {
    proposal: null,
    readiness: null,
    applying: false,
    outcome,
    receipts: [],
    confirm: vi.fn(),
    withdraw: vi.fn(),
    revise: vi.fn(),
    cancel: vi.fn(),
    apply: vi.fn(),
    undo: vi.fn(),
    refresh: vi.fn(),
  };
}

const applied = (receiptId = "r1"): ApplyOutcomeView => ({
  kind: "applied",
  receiptId,
  proposalId: "p1",
  proposalRevision: 1,
  documentRevision: 2,
  reloadRequired: false,
  diff: DIFF,
});

const highlighted = () => [...useChangeHighlightStore.getState().keys];

/** A screen row, as Task 3 renders one, so the scroll has a real target. */
function ChangedRow() {
  return <div {...useChangeTarget('shift:"EVE"')} />;
}
const arrived = (capabilityId: string) => ({
  status: "navigated",
  capabilityId,
  routeId: capabilityId,
  screenName: capabilityId,
  registry: { appBuildVersion: "t", manifestSha256: "t" },
});

beforeEach(() => {
  navigate.mockReset();
  navigate.mockImplementation(async (id: string) => arrived(id));
  useModeStore.setState({ mode: "advanced", adoption: "ready" });
});
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
afterEach(() => {
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  useHotStore.getState().resetRunView();
  cleanup();
  clearChangeHighlight();
  useModeStore.setState({ mode: "guided", adoption: "unhydrated" });
});

describe("ApplyNavigationNotice", () => {
  it("keeps an empty live region mounted before anything is applied", () => {
    render(<ApplyNavigationNotice controller={controller(null)} />);
    const status = screen.getByTestId("apply-navigation-status");
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("opens the primary screen without stealing focus, outlines it, and announces it", async () => {
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    render(
      <>
        <ChangedRow />
        <ApplyNavigationNotice controller={controller(applied())} />
      </>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("apply-navigation-status")).toHaveTextContent(
        "Opened Shift types. 3 shift types added.",
      ),
    );
    expect(navigate).toHaveBeenCalledWith("shift-types", { reveal: false });
    expect(highlighted()).toEqual(['shift:"EVE"', 'shift:"LATE"', 'shift:"N2"']);
    // Reduced motion: the scroll is never asked to be smooth.
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" }));
  });

  it("offers the other screens, and a link opens and outlines that one", async () => {
    const user = userEvent.setup();
    render(<ApplyNavigationNotice controller={controller(applied())} />);
    const link = await screen.findByRole("button", { name: /Staff \(1 person added\)/ });
    expect(link).toHaveAttribute("data-capability-id", "staff-list");
    await user.click(link);
    await waitFor(() => expect(highlighted()).toEqual(['person:"cy"']));
    expect(navigate).toHaveBeenLastCalledWith("staff-list", { reveal: false });
    expect(screen.getByTestId("apply-navigation-status")).toHaveTextContent(
      "Opened Staff. 1 person added.",
    );
  });

  it("stays put and offers a link when the user keeps their draft", async () => {
    navigate.mockResolvedValueOnce({
      status: CAPABILITY_UNAVAILABLE,
      reason: "navigation_cancelled",
      registry: { appBuildVersion: "t", manifestSha256: "t" },
    });
    render(<ApplyNavigationNotice controller={controller(applied())} />);
    await waitFor(() =>
      expect(screen.getByTestId("apply-navigation-status")).toHaveTextContent(
        "Stayed here so your unsaved edit is kept. The change is on Shift types. 3 shift types added.",
      ),
    );
    expect(highlighted()).toEqual([]);
    expect(
      screen
        .getAllByTestId("apply-navigation-link")
        .map((b) => b.getAttribute("data-capability-id")),
    ).toEqual(["shift-types", "staff-list"]);
  });

  it("does not leave the Optimise screen while a run is live, and offers the link", async () => {
    useHotStore
      .getState()
      .setRunView({ ...INITIAL_OPTIMIZE_RUN_VIEW, lifecycle: "running", jobId: "opt_1" });
    render(<ApplyNavigationNotice controller={controller(applied())} />);
    await waitFor(() =>
      expect(screen.getByTestId("apply-navigation-status")).toHaveTextContent(
        "Stayed here so the optimiser run keeps going. The change is on Shift types. 3 shift types added.",
      ),
    );
    expect(navigate).not.toHaveBeenCalled();
    expect(highlighted()).toEqual([]);
    expect(
      screen
        .getAllByTestId("apply-navigation-link")
        .map((b) => b.getAttribute("data-capability-id")),
    ).toEqual(["shift-types", "staff-list"]);
  });

  it("opens nothing when Apply failed", async () => {
    render(<ApplyNavigationNotice controller={controller({ kind: "failed", message: "no" })} />);
    await act(async () => {});
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.queryByTestId("apply-navigation")).toBeNull();
  });

  it("navigates once per receipt, however often it re-renders", async () => {
    const view = render(<ApplyNavigationNotice controller={controller(applied())} />);
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    view.rerender(<ApplyNavigationNotice controller={controller(applied())} />);
    await act(async () => {});
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("Done hides the notice but keeps the live region", async () => {
    const user = userEvent.setup();
    render(<ApplyNavigationNotice controller={controller(applied())} />);
    await user.click(await screen.findByTestId("apply-navigation-done"));
    expect(screen.queryByTestId("apply-navigation")).toBeNull();
    expect(screen.getByTestId("apply-navigation-status")).toHaveTextContent("");
  });

  it("clears the notice and the highlight once the applied receipt is undone", async () => {
    const view = render(<ApplyNavigationNotice controller={controller(applied())} />);
    await waitFor(() => expect(screen.getByTestId("apply-navigation")).toBeTruthy());
    expect(highlighted().length).toBeGreaterThan(0);

    // Undo resolves the outcome away: the hook stops claiming the change is applied.
    view.rerender(<ApplyNavigationNotice controller={controller(null)} />);

    expect(screen.queryByTestId("apply-navigation")).toBeNull();
    expect(highlighted()).toEqual([]);
  });

  it("does not come back when a later Preview is cancelled", async () => {
    const view = render(<ApplyNavigationNotice controller={controller(applied())} />);
    await waitFor(() => expect(screen.getByTestId("apply-navigation")).toBeTruthy());

    // A new Preview appears: the notice hides while it is reviewed.
    view.rerender(
      <ApplyNavigationNotice controller={{ ...controller(applied()), proposal: {} as never }} />,
    );
    expect(screen.queryByTestId("apply-navigation")).toBeNull();

    // That Preview is cancelled: the outcome clears too, same as a fresh mount would see.
    view.rerender(<ApplyNavigationNotice controller={controller(null)} />);
    expect(screen.queryByTestId("apply-navigation")).toBeNull();
    expect(highlighted()).toEqual([]);
  });
});
