// @vitest-environment jsdom
//
// F2 — the capture surface's guidance contract.
//
// The behaviour under test is not "a banner renders": it is that a run whose
// roster was silently NOT saved still tells the user so, with the right cause and
// without offering a Retry that could not work. A run in this state downloaded its
// XLSX and released its job, so nothing else on screen looks wrong.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  TERMINAL_UNAVAILABLE_CAUSES,
  type CaptureUnavailableCause,
  type RosterCaptureState,
} from "@/lib/optimize";
import { CaptureNotice } from "./capture-notice";

afterEach(() => cleanup());

function show(state: RosterCaptureState) {
  const onRetry = vi.fn();
  const onDismiss = vi.fn();
  render(
    <CaptureNotice state={state} onRetry={onRetry} onDismiss={onDismiss} dismissPending={false} />,
  );
  return { onRetry, onDismiss };
}

const unavailable = (cause: CaptureUnavailableCause): RosterCaptureState => ({
  status: "unavailable",
  cause,
});

describe("CaptureNotice — terminal unavailable guidance", () => {
  it("explains that browser storage must be fixed and the run repeated", () => {
    show(unavailable("snapshot_persist_failed"));
    const notice = screen.getByTestId("optimize-capture-storage-unavailable");
    expect(notice).toHaveTextContent(/browser storage/i);
    expect(notice).toHaveTextContent(/run the optimisation again/i);
    // Nothing here is retryable: the submission was never stored.
    expect(screen.queryByTestId("optimize-capture-retry")).not.toBeInTheDocument();
  });

  it("explains a missing stored submission and points at rerunning", () => {
    show(unavailable("snapshot_missing"));
    const notice = screen.getByTestId("optimize-capture-submission-missing");
    expect(notice).toHaveTextContent(/no longer available/i);
    expect(screen.queryByTestId("optimize-capture-retry")).not.toBeInTheDocument();
  });

  it("distinguishes 'this browser has no record of the run' from a missing snapshot", () => {
    // Recovery proved no durable record can attach for this job — a different
    // situation from a staged submission whose snapshot a read proved gone, and it
    // must not borrow that cause's wording or its test id.
    show(unavailable("session_record_absent"));
    const notice = screen.getByTestId("optimize-capture-record-absent");
    expect(notice).toHaveTextContent(/no record of the run/i);
    expect(notice).toHaveTextContent(/run the optimisation again/i);
    expect(screen.queryByTestId("optimize-capture-submission-missing")).not.toBeInTheDocument();
    expect(screen.queryByTestId("optimize-capture-retry")).not.toBeInTheDocument();
  });

  it("says plainly that no loadable roster was saved and the run cannot be recovered", () => {
    show(unavailable("assembly-rejected"));
    const notice = screen.getByTestId("optimize-capture-assembly-rejected");
    expect(notice).toHaveTextContent(/no loadable roster/i);
    expect(notice).toHaveTextContent(/cannot be recovered/i);
    // The load-bearing absence: the inputs are structurally terminal, so a Retry
    // would deterministically fail and must not be offered.
    expect(screen.queryByTestId("optimize-capture-retry")).not.toBeInTheDocument();
  });

  it("stays silent for a run that produced no schedule at all", () => {
    // The run panel already says the run produced no artifact; a second banner
    // saying its roster was not saved is noise, not information.
    const { container } = render(
      <CaptureNotice
        state={unavailable("no-artifact")}
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
        dismissPending={false}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("announces EVERY terminal unavailable cause — none is silently swallowed", () => {
    // Guards the gap the review found: the previous surface returned null for all
    // of them. Driven off the exported list so a new terminal cause cannot be added
    // without either wiring guidance or consciously excluding it here.
    for (const cause of TERMINAL_UNAVAILABLE_CAUSES) {
      const { container, unmount } = render(
        <CaptureNotice
          state={unavailable(cause)}
          onRetry={vi.fn()}
          onDismiss={vi.fn()}
          dismissPending={false}
        />,
      );
      expect(container, `no guidance rendered for ${cause}`).not.toBeEmptyDOMElement();
      unmount();
    }
  });
});

describe("CaptureNotice — actionable states still offer their action", () => {
  it("offers Retry for a transient fetch failure but not for a pruned job", async () => {
    const transient = show({
      status: "fetch-failed",
      message: "network down",
      jobGone: false,
      retryable: true,
    });
    await userEvent.click(screen.getByTestId("optimize-capture-retry"));
    expect(transient.onRetry).toHaveBeenCalled();
    cleanup();

    // A job the server has pruned can never be refetched, so no Retry.
    show({ status: "fetch-failed", message: "gone", jobGone: true, retryable: false });
    expect(screen.getByTestId("optimize-capture-fetch-failed")).toHaveTextContent(
      /no longer available on the server/i,
    );
    expect(screen.queryByTestId("optimize-capture-retry")).not.toBeInTheDocument();
  });

  it("offers NO Retry for a backend that cannot serve rosters, and states why", () => {
    // The user's 2026-08-10 screenshot: an old capture card reading
    // "could not be saved — Not Found" with a Retry button that re-sent the same
    // unsupported request forever. The job is NOT gone — the service simply has
    // no roster route — so `jobGone` cannot be what decides this. The closed
    // `retryable` verdict is.
    show({
      status: "fetch-failed",
      message:
        "The scheduling service this app is connected to does not support saving rosters, so it needs to be updated before rosters can be saved here.",
      jobGone: false,
      retryable: false,
    });

    const notice = screen.getByTestId("optimize-capture-fetch-failed");
    expect(notice).toHaveTextContent(/does not support saving rosters/i);
    expect(notice).toHaveTextContent(/needs to be updated/i);
    // Not the pruned-job wording: nothing here says the run vanished.
    expect(notice).not.toHaveTextContent(/no longer available on the server/i);
    expect(screen.queryByTestId("optimize-capture-retry")).not.toBeInTheDocument();
  });

  it("offers Retry for a retryable local commit failure", async () => {
    const { onRetry } = show({ status: "commit-failed", message: "quota exceeded" });
    await userEvent.click(screen.getByTestId("optimize-capture-retry"));
    expect(onRetry).toHaveBeenCalled();
  });

  it("offers Discard once a roster is saved, and a retry after a failed discard", async () => {
    const committed = show({
      status: "committed",
      pointer: { jobId: "opt_1", candidateVersion: 1, submissionOrdinal: 1 },
      // The notice is disposition-blind on purpose: "saved in this browser" is
      // true whether the commit filled an empty viewer or left a candidate
      // awaiting a choice, so it must not vary with this.
      working: { kind: "awaiting-choice", reason: "working-present" },
    });
    await userEvent.click(screen.getByTestId("optimize-capture-dismiss"));
    expect(committed.onDismiss).toHaveBeenCalled();
    cleanup();

    const failed = show({ status: "dismiss-failed", message: "storage unavailable" });
    expect(screen.getByTestId("optimize-capture-dismiss-failed")).toHaveTextContent(
      /still saved in this browser/i,
    );
    await userEvent.click(screen.getByTestId("optimize-capture-dismiss"));
    expect(failed.onDismiss).toHaveBeenCalled();
  });

  it("stays silent while capture is still running", () => {
    for (const state of [
      { status: "idle" },
      { status: "fetching-roster" },
      { status: "committing" },
      { status: "dismissed", reason: "user" },
    ] satisfies RosterCaptureState[]) {
      const { container, unmount } = render(
        <CaptureNotice
          state={state}
          onRetry={vi.fn()}
          onDismiss={vi.fn()}
          dismissPending={false}
        />,
      );
      expect(container, `unexpected notice for ${state.status}`).toBeEmptyDOMElement();
      unmount();
    }
  });
});
