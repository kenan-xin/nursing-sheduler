// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HistoryEditor, type HistoryOption } from "./history-editor";

afterEach(() => cleanup());

const OPTIONS: HistoryOption[] = [
  { id: "AM", label: "AM" },
  { id: "OFF", label: "OFF" },
  { id: "LEAVE", label: "LEAVE" },
];

describe("HistoryEditor", () => {
  it("renders who/position and every option", () => {
    render(
      <HistoryEditor
        open
        who="Kevin Ong"
        positionLabel="H-2"
        currentValue={null}
        options={OPTIONS}
        onSet={vi.fn()}
        onClear={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Kevin Ong · H-2")).toBeInTheDocument();
    OPTIONS.forEach((o) =>
      expect(screen.getByTestId(`history-editor-option-${o.id}`)).toBeInTheDocument(),
    );
  });

  it("marks the current value's option as selected", () => {
    render(
      <HistoryEditor
        open
        who="Kevin Ong"
        positionLabel="H-2"
        currentValue="OFF"
        options={OPTIONS}
        onSet={vi.fn()}
        onClear={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId("history-editor-option-OFF")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("history-editor-option-AM")).toHaveAttribute("aria-pressed", "false");
  });

  it("calls onSet with the option id when clicked", () => {
    const onSet = vi.fn();
    render(
      <HistoryEditor
        open
        who="Kevin Ong"
        positionLabel="H-2"
        currentValue={null}
        options={OPTIONS}
        onSet={onSet}
        onClear={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("history-editor-option-AM"));
    expect(onSet).toHaveBeenCalledWith("AM");
  });

  it("calls onClear when -- Clear -- is clicked, and onClose from Done", () => {
    const onClear = vi.fn();
    const onClose = vi.fn();
    render(
      <HistoryEditor
        open
        who="Kevin Ong"
        positionLabel="H-2"
        currentValue="AM"
        options={OPTIONS}
        onSet={vi.fn()}
        onClear={onClear}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByTestId("history-editor-clear"));
    expect(onClear).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByTestId("history-editor-done"));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// The shared-overlay half (F3). The option and Clear callbacks stay immediate
// and parent-owned; the overlay only has to add the portal, the canonical scrim
// and one close signal per dismissal.
// ---------------------------------------------------------------------------

function classesOf(element: Element | null): string {
  return element?.getAttribute("class") ?? "";
}

function renderEditor() {
  const onSet = vi.fn();
  const onClear = vi.fn();
  const onClose = vi.fn();
  render(
    <HistoryEditor
      open
      who="Kevin Ong"
      positionLabel="H-2"
      currentValue={null}
      options={OPTIONS}
      onSet={onSet}
      onClear={onClear}
      onClose={onClose}
    />,
  );
  return { onSet, onClear, onClose };
}

describe("HistoryEditor — shared overlay contract", () => {
  it("is an L2 raised card in the shared portal behind bg-scrim", () => {
    renderEditor();
    const popup = screen.getByTestId("history-editor");
    const overlay = document.querySelector("[data-slot='dialog-overlay']");
    expect(popup.closest("[data-slot='dialog-portal']")).not.toBeNull();
    expect(classesOf(popup)).toContain("bg-surface2");
    expect(classesOf(popup)).toContain("rounded-card");
    expect(classesOf(popup)).toContain("shadow-3");
    expect(classesOf(overlay)).toContain("bg-scrim");
    expect(classesOf(overlay)).not.toContain("bg-black");
  });

  it("names the slot through a real title and description", () => {
    renderEditor();
    const popup = screen.getByTestId("history-editor");
    expect(popup).toHaveAccessibleName("Edit history");
    expect(popup).toHaveAccessibleDescription("Kevin Ong · H-2");
  });
});

describe("HistoryEditor — dismissal closes without mutating", () => {
  it("the close control emits exactly ONE onClose — not one per handler", async () => {
    const { onSet, onClear, onClose } = renderEditor();
    await userEvent.click(screen.getByTestId("history-editor-close"));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSet).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
  });

  it("Escape closes without a new mutation", async () => {
    const { onSet, onClear, onClose } = renderEditor();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onSet).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
  });

  it("a backdrop press closes without a new mutation", async () => {
    const { onSet, onClear, onClose } = renderEditor();
    const overlay = document.querySelector("[data-slot='dialog-overlay']") as HTMLElement;
    await userEvent.click(overlay);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSet).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
  });

  it("an option selection still fires onSet exactly once, immediately", async () => {
    const { onSet, onClose } = renderEditor();
    await userEvent.click(screen.getByTestId("history-editor-option-AM"));
    expect(onSet).toHaveBeenCalledExactlyOnceWith("AM");
    expect(onClose).not.toHaveBeenCalled();
  });
});
