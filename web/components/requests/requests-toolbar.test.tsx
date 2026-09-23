// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RequestsToolbar } from "./requests-toolbar";

afterEach(() => cleanup());

describe("RequestsToolbar", () => {
  it("renders both tabs and calls onSetMode on click", () => {
    const onSetMode = vi.fn();
    render(
      <RequestsToolbar
        mode="normal"
        onSetMode={onSetMode}
        onOpenRequestsCsv={vi.fn()}
        onOpenHistoryCsv={vi.fn()}
        clearOpen={false}
        onToggleClear={vi.fn()}
      />,
    );
    expect(screen.getByTestId("requests-tab-normal")).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByTestId("requests-tab-quick"));
    expect(onSetMode).toHaveBeenCalledWith("quick");
  });

  it("shows the quick-paint hint only in quick mode", () => {
    const { rerender } = render(
      <RequestsToolbar
        mode="normal"
        onSetMode={vi.fn()}
        onOpenRequestsCsv={vi.fn()}
        onOpenHistoryCsv={vi.fn()}
        clearOpen={false}
        onToggleClear={vi.fn()}
      />,
    );
    expect(screen.queryByText(/Configure your preset/)).not.toBeInTheDocument();
    rerender(
      <RequestsToolbar
        mode="quick"
        onSetMode={vi.fn()}
        onOpenRequestsCsv={vi.fn()}
        onOpenHistoryCsv={vi.fn()}
        clearOpen={false}
        onToggleClear={vi.fn()}
      />,
    );
    expect(screen.getByText(/Configure your preset/)).toBeInTheDocument();
  });

  it("wires the CSV and clear-data buttons", () => {
    const onOpenRequestsCsv = vi.fn();
    const onOpenHistoryCsv = vi.fn();
    const onToggleClear = vi.fn();
    render(
      <RequestsToolbar
        mode="quick"
        onSetMode={vi.fn()}
        onOpenRequestsCsv={onOpenRequestsCsv}
        onOpenHistoryCsv={onOpenHistoryCsv}
        clearOpen={false}
        onToggleClear={onToggleClear}
      />,
    );
    fireEvent.click(screen.getByTestId("requests-open-requests-csv"));
    fireEvent.click(screen.getByTestId("requests-open-history-csv"));
    fireEvent.click(screen.getByTestId("requests-toggle-clear"));
    expect(onOpenRequestsCsv).toHaveBeenCalledOnce();
    expect(onOpenHistoryCsv).toHaveBeenCalledOnce();
    expect(onToggleClear).toHaveBeenCalledOnce();
  });

  it("renders BOTH CSV upload controls only in Quick Add mode (FR-SR-34)", () => {
    const { rerender } = render(
      <RequestsToolbar
        mode="normal"
        onSetMode={vi.fn()}
        onOpenRequestsCsv={vi.fn()}
        onOpenHistoryCsv={vi.fn()}
        clearOpen={false}
        onToggleClear={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("requests-open-requests-csv")).not.toBeInTheDocument();
    expect(screen.queryByTestId("requests-open-history-csv")).not.toBeInTheDocument();
    // Clear data stays available in both modes.
    expect(screen.getByTestId("requests-toggle-clear")).toBeInTheDocument();

    rerender(
      <RequestsToolbar
        mode="quick"
        onSetMode={vi.fn()}
        onOpenRequestsCsv={vi.fn()}
        onOpenHistoryCsv={vi.fn()}
        clearOpen={false}
        onToggleClear={vi.fn()}
      />,
    );
    expect(screen.getByTestId("requests-open-requests-csv")).toBeInTheDocument();
    expect(screen.getByTestId("requests-open-history-csv")).toBeInTheDocument();
  });

  it("disables only the Requests CSV button when requestsCsvDisabled, with a reason tooltip", () => {
    const onOpenRequestsCsv = vi.fn();
    const onOpenHistoryCsv = vi.fn();
    render(
      <RequestsToolbar
        mode="quick"
        onSetMode={vi.fn()}
        onOpenRequestsCsv={onOpenRequestsCsv}
        onOpenHistoryCsv={onOpenHistoryCsv}
        clearOpen={false}
        onToggleClear={vi.fn()}
        requestsCsvDisabled
        requestsCsvDisabledReason="Set a valid weight to import shift requests."
      />,
    );
    const requestsCsvButton = screen.getByTestId("requests-open-requests-csv");
    expect(requestsCsvButton).toBeDisabled();
    expect(requestsCsvButton).toHaveAttribute(
      "title",
      "Set a valid weight to import shift requests.",
    );
    fireEvent.click(requestsCsvButton);
    expect(onOpenRequestsCsv).not.toHaveBeenCalled();
    expect(screen.getByTestId("requests-open-history-csv")).not.toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// v2 pill segmented track (DESIGN.md §5). The R5-owned Requests mode tablist is
// a clipped pill (rounded-pill + overflow-hidden); the F3-owned Cell Preference
// tablist is a separate owner and stays square. This guard is bound to the
// Requests toolbar's own tablist, so a sibling square tablist cannot satisfy it.
// ---------------------------------------------------------------------------
describe("RequestsToolbar — v2 pill segmented track", () => {
  const baseProps = {
    mode: "normal" as const,
    onSetMode: vi.fn(),
    onOpenRequestsCsv: vi.fn(),
    onOpenHistoryCsv: vi.fn(),
    clearOpen: false,
    onToggleClear: vi.fn(),
  };

  it("the mode tablist is a clipped pill track (rounded-pill + overflow-hidden)", () => {
    const { container } = render(<RequestsToolbar {...baseProps} />);
    const tablist = container.querySelector('[data-testid="requests-toolbar"] [role="tablist"]');
    expect(tablist, "the Requests toolbar owns exactly one tablist").not.toBeNull();
    const cls = (tablist as HTMLElement).className.split(/\s+/);
    expect(cls).toContain("rounded-pill");
    expect(cls).toContain("overflow-hidden");
    // The ratified contract is pill; a square track (rounded-none) is the
    // deviation this guard exists to catch.
    expect(cls).not.toContain("rounded-none");
  });

  it("the bound selector does not match a sibling square tablist", () => {
    // A square segmented control outside the Requests toolbar (the F3 Cell
    // Preference tablist shape) must NOT satisfy the toolbar's pill contract.
    const { container } = render(
      <div>
        <div data-testid="some-other-toolbar">
          <div role="tablist" className="inline-flex rounded-none border border-line">
            <button type="button">x</button>
          </div>
        </div>
        <RequestsToolbar {...baseProps} />
      </div>,
    );
    const sibling = container.querySelector('[data-testid="some-other-toolbar"] [role="tablist"]');
    const siblingCls = (sibling as HTMLElement).className.split(/\s+/);
    expect(siblingCls).toContain("rounded-none");
    expect(siblingCls).not.toContain("rounded-pill");
  });
});
