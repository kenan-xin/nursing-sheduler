// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OptimizeRecovery, OptimizeResumeOutcome } from "@/lib/optimize";
import { RecoveryNotice, type RecoveryNoticeProps } from "./recovery-notice";

afterEach(() => cleanup());

function setup(over: Partial<RecoveryNoticeProps> = {}) {
  const props: RecoveryNoticeProps = {
    state: { kind: "none" } as OptimizeRecovery,
    resume: null as OptimizeResumeOutcome | null,
    reloadRecoveryUnavailable: false,
    onForget: vi.fn(),
    forgetPending: false,
    ...over,
  };
  render(<RecoveryNotice {...props} />);
  return props;
}

describe("RecoveryNotice", () => {
  it("renders nothing for a clean slate", () => {
    const { container } = render(
      <RecoveryNotice
        state={{ kind: "none" }}
        resume={null}
        reloadRecoveryUnavailable={false}
        onForget={vi.fn()}
        forgetPending={false}
      />,
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

  it("offers a destructive Forget for an interrupted record and warns about the unknown job", async () => {
    const props = setup({ state: { kind: "interrupted", anonymized: true, peopleCount: 3 } });
    const notice = screen.getByTestId("optimize-interrupted");
    expect(notice).toHaveTextContent("An unknown backend optimization may still be running");
    await userEvent.click(screen.getByTestId("optimize-forget"));
    expect(props.onForget).toHaveBeenCalled();
  });

  it("offers Forget for an unreadable record", () => {
    setup({ state: { kind: "unreadable" } });
    expect(screen.getByTestId("optimize-unreadable")).toBeInTheDocument();
    expect(screen.getByTestId("optimize-forget")).toBeInTheDocument();
  });

  it("explains a storage-error state without a Forget action", () => {
    setup({ state: { kind: "storage-error" } });
    expect(screen.getByTestId("optimize-storage-error")).toBeInTheDocument();
    expect(screen.queryByTestId("optimize-forget")).not.toBeInTheDocument();
  });

  it("warns when reload recovery is unavailable for a degraded run", () => {
    setup({ reloadRecoveryUnavailable: true });
    expect(screen.getByTestId("optimize-degraded")).toHaveTextContent(
      "Reload recovery is unavailable for this run.",
    );
  });

  it("disables Forget while a forget is pending", () => {
    setup({
      state: { kind: "interrupted", anonymized: false, peopleCount: 1 },
      forgetPending: true,
    });
    expect(screen.getByTestId("optimize-forget")).toBeDisabled();
  });
});
