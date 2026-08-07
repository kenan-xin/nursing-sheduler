// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { OptimizeRecovery, OptimizeResumeOutcome } from "@/lib/optimize";
import { RecoveryNotice, type RecoveryNoticeProps } from "./recovery-notice";

afterEach(() => cleanup());

function setup(over: Partial<RecoveryNoticeProps> = {}) {
  const props: RecoveryNoticeProps = {
    state: { kind: "none" } as OptimizeRecovery,
    resume: null as OptimizeResumeOutcome | null,
    reloadRecoveryUnavailable: false,
    ...over,
  };
  render(<RecoveryNotice {...props} />);
  return props;
}

describe("RecoveryNotice", () => {
  it("renders nothing for a clean slate", () => {
    const { container } = render(
      <RecoveryNotice state={{ kind: "none" }} resume={null} reloadRecoveryUnavailable={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("announces a resumed run", () => {
    setup({
      state: { kind: "resumable", jobId: "opt_1", anonymized: false, peopleCount: 2 },
      resume: { status: "attached", jobId: "opt_1" },
    });
    expect(screen.getByTestId("optimize-resumed")).toBeInTheDocument();
  });

  it("surfaces a failed resume", () => {
    setup({
      state: { kind: "resumable", jobId: "opt_1", anonymized: false, peopleCount: 2 },
      resume: { status: "conflict", reason: "already attached" },
    });
    expect(screen.getByTestId("optimize-resume-failed")).toHaveTextContent("already attached");
  });

  it("renders NOTHING for a prior interrupted or unreadable record", () => {
    // The settled product boundary: users are never asked to hold a prior-run
    // recovery concept. An interrupted record is retired invisibly by the next
    // Optimize click, and an unreadable one just makes that click report plainly
    // that optimisation could not start. Neither gets a notice, an action, or any
    // recovery vocabulary here.
    for (const state of [
      { kind: "interrupted", anonymized: true, peopleCount: 3 },
      { kind: "unreadable" },
    ] satisfies OptimizeRecovery[]) {
      const { container, unmount } = render(
        <RecoveryNotice state={state} resume={null} reloadRecoveryUnavailable={false} />,
      );
      expect(container, `${state.kind} rendered a recovery notice`).toBeEmptyDOMElement();
      unmount();
    }
  });

  it("explains a storage-error state, with no action to take", () => {
    setup({ state: { kind: "storage-error" } });
    expect(screen.getByTestId("optimize-storage-error")).toBeInTheDocument();
  });

  it("warns when reload recovery is unavailable for a degraded run", () => {
    setup({ reloadRecoveryUnavailable: true });
    expect(screen.getByTestId("optimize-degraded")).toHaveTextContent(
      "Reload recovery is unavailable for this run.",
    );
  });
});
