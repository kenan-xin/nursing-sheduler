// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ClearConfirmDialog } from "./clear-confirm-dialog";

afterEach(() => cleanup());

describe("ClearConfirmDialog", () => {
  it("renders the confirm text when open", () => {
    render(
      <ClearConfirmDialog
        open
        text="Clear all shift requests? This cannot be undone."
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId("clear-confirm-dialog")).toHaveTextContent(
      "Clear all shift requests? This cannot be undone.",
    );
  });

  it("does not render when closed", () => {
    render(<ClearConfirmDialog open={false} text="text" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByTestId("clear-confirm-dialog")).not.toBeInTheDocument();
  });

  it("calls onConfirm only, not onCancel, when Clear is clicked", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ClearConfirmDialog open text="text" onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId("clear-confirm-confirm"));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("calls onCancel when Cancel is clicked", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ClearConfirmDialog open text="text" onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId("clear-confirm-cancel"));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
