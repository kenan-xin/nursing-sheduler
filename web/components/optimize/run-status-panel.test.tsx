// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { INITIAL_OPTIMIZE_RUN_VIEW, type OptimizeRunView } from "@/lib/optimize";
import { judgeVolatileJobIdTexts, VOLATILE_JOB_ID_SELECTOR } from "@/e2e/support/optimize-durable";
import { RunStatusPanel, type RunStatusPanelProps } from "./run-status-panel";

// GuardedLink (the infeasible "Adjust rules" CTA) reads the Next router; a lightweight
// stub keeps this a focused render test, mirroring readiness-banner.test.tsx.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/optimize-and-export",
}));

afterEach(() => cleanup());

const handlers = {
  onCancel: vi.fn(),
  onFinishNow: vi.fn(),
  onDownloadArtifact: vi.fn(),
  onDownloadAgain: vi.fn(),
};

/**
 * The rendered job-id LINE, located through the ownership hook on its value.
 *
 * The hook sits on the id VALUE, so the line is one element with a nested <span>
 * and `getByText("Job ID: opt_1")` no longer matches it — that query compares an
 * element's own direct text nodes. Reading `textContent` off the line instead is
 * what keeps the COPY assertions byte-exact across that structural change.
 */
function jobIdLine(): HTMLElement | null {
  return document.querySelector(VOLATILE_JOB_ID_SELECTOR)?.closest("p") ?? null;
}

function view(over: Partial<OptimizeRunView>): OptimizeRunView {
  return { ...INITIAL_OPTIMIZE_RUN_VIEW, ...over };
}

function setup(v: OptimizeRunView, over: Partial<RunStatusPanelProps> = {}) {
  const props: RunStatusPanelProps = {
    view: v,
    submitting: false,
    canDownloadAgain: false,
    downloadAgainFilename: null,
    ...handlers,
    ...over,
  };
  render(<RunStatusPanel {...props} />);
  return props;
}

describe("RunStatusPanel — idle empty state", () => {
  it("shows the centered empty state instead of the bare score skeleton", () => {
    setup(INITIAL_OPTIMIZE_RUN_VIEW);
    expect(screen.getByTestId("optimize-idle")).toHaveTextContent("Ready to optimise");
    // No live score skeleton while idle.
    expect(screen.queryByTestId("optimize-score")).not.toBeInTheDocument();
    expect(screen.queryByTestId("optimize-status")).not.toBeInTheDocument();
  });

  it("renders the in-panel Optimize CTA only when an onStartRun handler is wired", async () => {
    const onStartRun = vi.fn();
    setup(INITIAL_OPTIMIZE_RUN_VIEW, { onStartRun });
    const cta = screen.getByTestId("optimize-start");
    await userEvent.click(cta);
    expect(onStartRun).toHaveBeenCalled();
  });

  it("omits the in-panel CTA when no run-start handler is provided", () => {
    setup(INITIAL_OPTIMIZE_RUN_VIEW);
    expect(screen.queryByTestId("optimize-start")).not.toBeInTheDocument();
  });

  it("does not treat the brief submitting window as idle", () => {
    setup(INITIAL_OPTIMIZE_RUN_VIEW, { submitting: true });
    // submitting masks idle — the live skeleton (status badge) renders instead.
    expect(screen.queryByTestId("optimize-idle")).not.toBeInTheDocument();
    expect(screen.getByTestId("optimize-status")).toBeInTheDocument();
  });
});

describe("RunStatusPanel — status and score", () => {
  it("shows the live incumbent and queue position", () => {
    setup(view({ lifecycle: "queued", jobId: "opt_1", queuePosition: 3, latestScore: 12 }));
    expect(screen.getByTestId("optimize-status")).toHaveTextContent("Queued, position 3");
    expect(screen.getByTestId("optimize-score")).toHaveTextContent("12");
    expect(jobIdLine()?.textContent).toBe("Job ID: opt_1");
  });

  // THE OWNERSHIP HOOK. The assembled gate's fail-closed cleanup recovers a live job
  // id through this exact selector when the durable session record stayed provisional
  // (`activation-persistence-failed`), so the selector and this markup are one
  // contract. Pinning them together here means a drift is a red unit test in seconds
  // rather than a silent "no job id to recover" inside the Compose gate. The read is
  // driven through the real judge, so the DOM is proved to satisfy the same total
  // function the gate runs — not merely to contain a matching node.
  it("exposes the live job id through the stable ownership hook, value only", () => {
    setup(view({ lifecycle: "running", jobId: "opt_1" }));
    const nodes = Array.from(document.querySelectorAll(VOLATILE_JOB_ID_SELECTOR));
    expect(nodes).toHaveLength(1);
    // The hook is on the VALUE: no label prose inside it, so the judge accepts it.
    expect(nodes[0].textContent).toBe("opt_1");
    expect(judgeVolatileJobIdTexts(nodes.map((node) => node.textContent))).toEqual({
      ok: true,
      ids: ["opt_1"],
    });
    // ...and the user-visible copy is byte-identical to what it was before the hook.
    expect(jobIdLine()?.textContent).toBe("Job ID: opt_1");
  });

  // ABSENCE must stay absence: no hook when there is no job, so recovery reports an
  // empty set and settlement fails closed on cardinality rather than inventing an id.
  it("renders no ownership hook while the run has no job id", () => {
    setup(view({ lifecycle: "submitting", jobId: null }));
    const nodes = Array.from(document.querySelectorAll(VOLATILE_JOB_ID_SELECTOR));
    expect(nodes).toHaveLength(0);
    expect(judgeVolatileJobIdTexts(nodes.map((node) => node.textContent))).toEqual({
      ok: true,
      ids: [],
    });
  });
});

describe("RunStatusPanel — controls", () => {
  it("gates cancel and finish-now on server controls", async () => {
    const props = setup(
      view({
        lifecycle: "running",
        jobId: "opt_1",
        controls: { cancellable: true, earlyCompletionAvailable: false },
      }),
    );
    const finish = screen.getByTestId("optimize-finish-now");
    const cancel = screen.getByTestId("optimize-cancel");
    expect(finish).toBeDisabled();
    expect(cancel).toBeEnabled();
    await userEvent.click(cancel);
    expect(props.onCancel).toHaveBeenCalled();
  });

  it("shows the cancelling label", () => {
    setup(
      view({
        lifecycle: "cancelling",
        jobId: "opt_1",
        controls: { cancellable: false, earlyCompletionAvailable: false },
      }),
    );
    expect(screen.getByTestId("optimize-cancel")).toHaveTextContent("Cancelling…");
  });
});

describe("RunStatusPanel — terminal outcomes", () => {
  it("row 1: completed with a downloaded artifact shows success and Download Again", () => {
    setup(
      view({
        lifecycle: "completed",
        jobId: "opt_1",
        result: { outcome: "optimal", score: 42, solverStatus: "OPTIMAL", terminationReason: null },
        latestScore: 42,
        download: { status: "downloaded", artifactAvailable: true, filename: "schedule.xlsx" },
      }),
      { canDownloadAgain: true, downloadAgainFilename: "schedule.xlsx" },
    );
    expect(screen.getByTestId("optimize-completed-artifact")).toHaveTextContent(
      "Schedule optimised and downloaded successfully!",
    );
    expect(screen.getByTestId("optimize-download-again")).toHaveTextContent("schedule.xlsx");
  });

  it("success: terminal heading + SOLVER STATUS / FINAL SCORE / ELAPSED grid", () => {
    setup(
      view({
        lifecycle: "completed",
        jobId: "opt_1",
        result: {
          outcome: "feasible",
          score: -142,
          solverStatus: "FEASIBLE",
          terminationReason: "solver_timeout",
        },
        latestScore: -142,
        startedAt: "2026-07-20T00:00:01+00:00",
        finishedAt: "2026-07-20T00:00:19.4+00:00",
        download: { status: "available", artifactAvailable: true, filename: null },
      }),
    );
    // Terminal outcome heading (not the live score skeleton).
    expect(screen.getByRole("heading")).toHaveTextContent("A feasible roster was found");
    const grid = screen.getByTestId("optimize-summary-grid");
    expect(grid).toHaveTextContent("FEASIBLE");
    expect(grid).toHaveTextContent("Final score");
    expect(grid).toHaveTextContent("-142");
    expect(grid).toHaveTextContent("Elapsed");
    // 18.4s derived from the job timestamps (not a progress frame); the ladder
    // rounds to whole seconds once ≥ 10s.
    expect(grid).toHaveTextContent("18s");
  });

  it("success: ELAPSED shows — when a timestamp is absent", () => {
    setup(
      view({
        lifecycle: "completed",
        jobId: "opt_1",
        result: { outcome: "optimal", score: 9, solverStatus: "OPTIMAL", terminationReason: null },
        // No startedAt/finishedAt on the view.
        download: { status: "available", artifactAvailable: true, filename: null },
      }),
    );
    expect(screen.getByTestId("optimize-summary-grid")).toHaveTextContent("—");
  });

  it("row 1 retry: a failed download offers a manual Download", async () => {
    const props = setup(
      view({
        lifecycle: "completed",
        jobId: "opt_1",
        download: { status: "available", artifactAvailable: true, filename: null },
        error: { source: "job", code: null, message: "network hiccup" },
      }),
    );
    await userEvent.click(screen.getByTestId("optimize-download"));
    expect(props.onDownloadArtifact).toHaveBeenCalled();
  });

  it("infeasible: dedicated panel with heading, verdict label, and Adjust rules only", () => {
    setup(
      view({
        lifecycle: "completed",
        jobId: "opt_1",
        result: {
          outcome: "infeasible",
          score: null,
          solverStatus: "INFEASIBLE",
          terminationReason: "infeasibility_proven",
        },
        download: { status: "unavailable", artifactAvailable: false, filename: null },
      }),
    );
    expect(screen.getByRole("heading")).toHaveTextContent("This roster can't be built");
    const panel = screen.getByTestId("optimize-infeasible");
    expect(panel).toHaveTextContent("verdict: infeasibility_proven");
    // No per-conflict list, no generic no-artifact callout.
    expect(screen.queryByTestId("optimize-no-artifact")).not.toBeInTheDocument();
    // Adjust rules is a self-contained GuardedLink to /rules.
    const adjust = screen.getByTestId("optimize-adjust-rules");
    expect(adjust).toHaveAttribute("href", "/rules");
    expect(adjust).toHaveTextContent("Adjust rules");
    // NO `Try again`. On an infeasible result it was the least useful button on
    // the screen — the solver proved no roster satisfies the rules, so re-running
    // the same scenario proves it again. `Adjust rules` is the actionable move,
    // and the exact `Optimize` action is the way back.
    expect(screen.queryByTestId("optimize-try-again")).not.toBeInTheDocument();
  });

  // G6.2a RETIRED THE TERMINAL ACTIONS. `Resubmit` / `Try again`, `Dismiss` and the
  // cleanup `Retry` all existed to serve the single-slot design: a terminal run
  // OCCUPIED the one session record, so the user needed a way to release it, and a
  // second run had to wait for that release. Records are owner-keyed now, nothing
  // occupies anything, and a second run is simply the exact `Optimize` action.
  //
  // Enumerated one test id at a time rather than as a group, so bringing any single
  // one back fails here.
  it.each([
    [
      "worker-lost",
      view({
        lifecycle: "failed",
        jobId: "opt_1",
        error: { source: "job", code: "worker_lost", message: "Worker lost." },
      }),
      "Worker lost.",
    ],
    [
      "cancelled",
      view({
        lifecycle: "cancelled",
        jobId: "opt_1",
        error: { source: "job", code: "cancelled", message: "Optimisation cancelled." },
      }),
      "Optimisation cancelled.",
    ],
    [
      "process_timeout",
      view({
        lifecycle: "failed",
        jobId: "opt_1",
        error: { source: "job", code: "process_timeout", message: "Solver process timed out." },
      }),
      "Solver process timed out.",
    ],
  ])("row 3: a %s run reports honestly and offers nothing to press", (_label, runView, message) => {
    setup(runView);
    // The report survives — what is gone is asking the user to act on it.
    expect(screen.getByTestId("optimize-terminal-error")).toHaveTextContent(message);
    for (const retired of [
      "optimize-resubmit",
      "optimize-dismiss",
      "optimize-try-again",
      "optimize-cleanup-retry",
      "optimize-cleanup-abandon",
    ]) {
      expect(screen.queryByTestId(retired), retired).not.toBeInTheDocument();
    }
  });
});

describe("RunStatusPanel — no cleanup surface at all", () => {
  it("a completed run shows its result and never a tidying-up notice", () => {
    setup(
      view({
        lifecycle: "completed",
        jobId: "opt_1",
        download: { status: "downloaded", artifactAvailable: true, filename: "schedule.xlsx" },
      }),
      { canDownloadAgain: true, downloadAgainFilename: "schedule.xlsx" },
    );
    // The successful terminal view is intact.
    expect(screen.getByTestId("optimize-download-again")).toBeInTheDocument();
    // And cleanup is invisible: it cannot stand in a new run's way, so there is
    // nothing here for a user to decide.
    expect(screen.queryByTestId("optimize-cleanup-failed")).not.toBeInTheDocument();
    expect(screen.queryByTestId("optimize-cleanup-retry")).not.toBeInTheDocument();
  });
});

describe("RunStatusPanel — G4 Open & adjust roster CTA", () => {
  // G4 closure: the prototype's `Open & adjust roster` CTA appears inside the
  // completed artifact block ONLY when `loadableRoster` is true. Every other
  // terminal outcome must stay silent — idle, running, failed,
  // infeasible-without-incumbent, dismissed — so the panel cannot claim a
  // roster exists for a non-loadable run.

  const completedWithArtifact = view({
    lifecycle: "completed",
    jobId: "opt_1",
    result: { outcome: "optimal", score: 42, solverStatus: "OPTIMAL", terminationReason: null },
    latestScore: 42,
    download: { status: "downloaded", artifactAvailable: true, filename: "schedule.xlsx" },
  });

  it("renders the CTA with calendar-check icon when loadableRoster is true", () => {
    setup(completedWithArtifact, { loadableRoster: true });
    const cta = screen.getByTestId("optimize-open-roster");
    expect(cta).toHaveAttribute("href", "/roster");
    expect(cta).toHaveTextContent("Open & adjust roster");
  });

  it("omits the CTA on a completed run that has no loadable roster", () => {
    setup(completedWithArtifact, { loadableRoster: false });
    expect(screen.queryByTestId("optimize-open-roster")).not.toBeInTheDocument();
    // The success download affordance remains intact — the "downloaded"
    // status still surfaces the success callout.
    expect(screen.getByTestId("optimize-completed-artifact")).toHaveTextContent(
      "Schedule optimised and downloaded successfully!",
    );
  });

  it("omits the CTA by default (the prop is opt-in)", () => {
    setup(completedWithArtifact);
    expect(screen.queryByTestId("optimize-open-roster")).not.toBeInTheDocument();
  });

  it("never renders the CTA for a non-completed lifecycle", () => {
    for (const lifecycle of [
      "idle",
      "queued",
      "running",
      "cancelling",
      "cancelled",
      "failed",
    ] as const) {
      setup(
        view({
          lifecycle,
          jobId: lifecycle === "idle" ? null : "opt_1",
          // artifactAvailable is irrelevant — the CTA must not render unless
          // lifecycle is "completed".
          download: { status: "downloaded", artifactAvailable: true, filename: null },
        }),
        { loadableRoster: true },
      );
      expect(
        screen.queryByTestId("optimize-open-roster"),
        `CTA rendered for lifecycle=${lifecycle}`,
      ).not.toBeInTheDocument();
      cleanup();
    }
  });

  it("never renders the CTA on a completed run with no downloadable artifact", () => {
    setup(
      view({
        lifecycle: "completed",
        jobId: "opt_1",
        result: {
          outcome: "infeasible",
          score: null,
          solverStatus: "INFEASIBLE",
          terminationReason: "infeasibility_proven",
        },
        download: { status: "unavailable", artifactAvailable: false, filename: null },
      }),
      { loadableRoster: true },
    );
    // The infeasible panel owns the success view; the CTA must not appear.
    expect(screen.queryByTestId("optimize-open-roster")).not.toBeInTheDocument();
  });
});

describe("RunStatusPanel — transient error", () => {
  it("shows a non-terminal control/stream error while active", () => {
    setup(
      view({
        lifecycle: "running",
        jobId: "opt_1",
        error: { source: "stream", code: null, message: "stream disconnected" },
        controls: { cancellable: true, earlyCompletionAvailable: false },
      }),
    );
    expect(screen.getByTestId("optimize-transient-error")).toHaveTextContent("stream disconnected");
  });
});
