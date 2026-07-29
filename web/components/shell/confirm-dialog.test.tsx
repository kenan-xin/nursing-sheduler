// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDialog } from "./confirm-dialog";

// The shell confirm is the app's single confirmation shell (New schedule / Start
// over, the dirty-navigation guard, every cascade delete, and the Save/Load
// version gate that wraps it). What is pinned here is the SIGNAL contract: a
// confirm fires `onConfirm` exactly once, a cancel fires it never, and no
// implicit dismissal can reach it — plus one `onOpenChange(false)` per close,
// because a duplicate would double-advance a caller that closes on a counter.

function classesOf(element: Element | null): string {
  return element?.getAttribute("class") ?? "";
}

function renderConfirm(props: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  const onConfirm = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title="Start over?"
      description="This clears the current schedule."
      onConfirm={onConfirm}
      {...props}
    />,
  );
  return { onConfirm, onOpenChange };
}

afterEach(() => cleanup());

describe("ConfirmDialog — shared alert-dialog contract", () => {
  it("renders through the shared portal as an L2 raised card behind bg-scrim", () => {
    const { container } = render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Start over?"
        description="body"
        onConfirm={vi.fn()}
      />,
    );
    const popup = screen.getByTestId("confirm-dialog");
    const overlay = document.querySelector("[data-slot='alert-dialog-overlay']");
    expect(container).not.toContainElement(popup);
    expect(popup.closest("[data-slot='alert-dialog-portal']")).not.toBeNull();
    expect(classesOf(popup)).toContain("bg-surface2");
    expect(classesOf(popup)).toContain("rounded-card");
    expect(classesOf(popup)).toContain("shadow-3");
    expect(classesOf(overlay)).toContain("bg-scrim");
    expect(classesOf(overlay)).not.toContain("bg-black");
  });

  it("sits on the base stacking layer, leaving the nested layer to a raised confirm", () => {
    renderConfirm();
    expect(screen.getByTestId("confirm-dialog")).toHaveAttribute("data-layer", "base");
  });

  it("exposes a real title and description and contains focus", async () => {
    renderConfirm();
    const popup = screen.getByTestId("confirm-dialog");
    expect(popup).toHaveAccessibleName("Start over?");
    expect(popup).toHaveAccessibleDescription("This clears the current schedule.");
    await waitFor(() => expect(popup).toContainElement(document.activeElement as HTMLElement));
  });

  it("keeps the destructive and default variants distinct", () => {
    const { unmount } = render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Delete"
        description="body"
        variant="destructive"
        onConfirm={vi.fn()}
      />,
    );
    expect(document.querySelector("[data-slot='alert-dialog-media']")).toHaveAttribute(
      "data-tone",
      "error",
    );
    unmount();

    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Continue"
        description="body"
        onConfirm={vi.fn()}
      />,
    );
    expect(document.querySelector("[data-slot='alert-dialog-media']")).toHaveAttribute(
      "data-tone",
      "brand",
    );
  });

  it("keeps the optional consequence list and the caller's labels verbatim", () => {
    renderConfirm({
      confirmLabel: "Start over",
      cancelLabel: "Keep editing",
      consequences: ["All shift requests are cleared.", "Undo history is discarded."],
    });
    expect(screen.getByTestId("confirm-dialog-confirm")).toHaveTextContent("Start over");
    expect(screen.getByTestId("confirm-dialog-cancel")).toHaveTextContent("Keep editing");
    expect(screen.getByTestId("confirm-dialog-consequences")).toHaveTextContent(
      "All shift requests are cleared.",
    );
  });
});

describe("ConfirmDialog — exactly-once signals", () => {
  it("Confirm calls onConfirm once and emits exactly one close", async () => {
    const { onConfirm, onOpenChange } = renderConfirm();
    await userEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Cancel emits exactly one close and never confirms", async () => {
    const { onConfirm, onOpenChange } = renderConfirm();
    await userEvent.click(screen.getByTestId("confirm-dialog-cancel"));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledOnce();
    // Base UI passes its own event details as a second argument; the caller
    // contract is only the first, so assert on that rather than on arity.
    expect(onOpenChange.mock.calls[0][0]).toBe(false);
  });

  it("Escape closes without ever reaching the domain action", async () => {
    const { onConfirm, onOpenChange } = renderConfirm();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledOnce());
    expect(onOpenChange.mock.calls[0][0]).toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("a backdrop press neither confirms nor dismisses an alert dialog", async () => {
    const { onConfirm, onOpenChange } = renderConfirm();
    const overlay = document.querySelector("[data-slot='alert-dialog-overlay']") as HTMLElement;
    await userEvent.click(overlay);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
