// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

// ---------------------------------------------------------------------------
// The shared-overlay half (F3). This confirm owns the app's one reserved
// `nested` / z-60 layer. On the current live Requests route it is the sole
// overlay mounted while it is open — no base-layer Requests dialog sits beneath
// it — so what is pinned below is its own layer identity, not a relation to a
// second overlay. Being a clear-data gate, no implicit dismissal may ever route
// to `onConfirm`.
// ---------------------------------------------------------------------------

function classesOf(element: Element | null): string {
  return element?.getAttribute("class") ?? "";
}

function renderConfirm() {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ClearConfirmDialog
      open
      text="Clear all shift requests?"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  return { onConfirm, onCancel };
}

describe("ClearConfirmDialog — shared overlay contract", () => {
  it("is an L2 raised card behind the semantic scrim, in the shared portal", () => {
    renderConfirm();
    const popup = screen.getByTestId("clear-confirm-dialog");
    const overlay = document.querySelector("[data-slot='alert-dialog-overlay']");
    expect(popup.closest("[data-slot='alert-dialog-portal']")).not.toBeNull();
    expect(classesOf(popup)).toContain("bg-surface2");
    expect(classesOf(popup)).toContain("rounded-card");
    expect(classesOf(popup)).toContain("shadow-3");
    expect(classesOf(overlay)).toContain("bg-scrim");
    expect(classesOf(overlay)).not.toContain("bg-black");
  });

  it("carries the reserved nested layer identity on both its popup and its scrim", () => {
    renderConfirm();
    const popup = screen.getByTestId("clear-confirm-dialog");
    const overlay = document.querySelector("[data-slot='alert-dialog-overlay']");
    expect(popup).toHaveAttribute("data-layer", "nested");
    expect(classesOf(popup)).toContain("z-60");
    expect(overlay).toHaveAttribute("data-layer", "nested");
    expect(classesOf(overlay)).toContain("z-60");
  });

  it("exposes a real title and description", () => {
    renderConfirm();
    const popup = screen.getByTestId("clear-confirm-dialog");
    expect(popup).toHaveAccessibleName("Confirm");
    expect(popup).toHaveAccessibleDescription("Clear all shift requests?");
  });
});

describe("ClearConfirmDialog — no implicit dismissal can clear data", () => {
  it("Escape routes to onCancel only", async () => {
    const { onConfirm, onCancel } = renderConfirm();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(onCancel).toHaveBeenCalledOnce());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("a backdrop press neither clears nor cancels — an alert dialog is not outside-dismissable", async () => {
    const { onConfirm, onCancel } = renderConfirm();
    const overlay = document.querySelector("[data-slot='alert-dialog-overlay']") as HTMLElement;
    await userEvent.click(overlay);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Clear fires onConfirm exactly once and never onCancel", async () => {
    const { onConfirm, onCancel } = renderConfirm();
    await userEvent.click(screen.getByTestId("clear-confirm-confirm"));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Cancel fires onCancel exactly once — one signal, not one per close route", async () => {
    const { onConfirm, onCancel } = renderConfirm();
    await userEvent.click(screen.getByTestId("clear-confirm-cancel"));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
