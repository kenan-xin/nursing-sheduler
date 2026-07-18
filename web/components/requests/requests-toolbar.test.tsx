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
