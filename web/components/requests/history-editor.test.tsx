// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
