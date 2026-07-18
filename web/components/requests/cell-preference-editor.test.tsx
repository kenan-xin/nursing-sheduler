// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { UiRequestCell } from "@/lib/scenario";
import {
  CellPreferenceEditor,
  type CellEditorResult,
  type WeightTarget,
} from "./cell-preference-editor";

afterEach(() => cleanup());

const TARGETS: WeightTarget[] = [
  { id: "AM", name: "Morning", isGroup: false },
  { id: "PM", name: "Evening", isGroup: false },
  { id: "EARLY", name: "Early shifts", isGroup: true },
];

function renderEditor(
  overrides: Partial<{
    cells: UiRequestCell[];
    onSave: (result: CellEditorResult) => void;
    onClear: () => void;
    onClose: () => void;
  }> = {},
) {
  const onSave = overrides.onSave ?? vi.fn();
  const onClear = overrides.onClear ?? vi.fn();
  const onClose = overrides.onClose ?? vi.fn();
  render(
    <CellPreferenceEditor
      open
      personLabel="1. Kevin Ong"
      dateLabel="2026-01-05"
      cells={overrides.cells ?? []}
      targets={TARGETS}
      onSave={onSave}
      onClear={onClear}
      onClose={onClose}
    />,
  );
  return { onSave, onClear, onClose };
}

describe("CellPreferenceEditor — seeding from existing cells", () => {
  it("defaults to the Available tab with zeroed weights when the coordinate is empty", () => {
    renderEditor();
    expect(screen.getByTestId("cell-editor-tab-available")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("cell-editor-weight-input-AM")).toHaveValue("0");
  });

  it("seeds the Leave tab when a leave cell is present (day-state precedence)", () => {
    renderEditor({ cells: [{ kind: "leave", person: "kevin", date: "2026-01-05" }] });
    expect(screen.getByTestId("cell-editor-tab-leave")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("cell-editor-leave-note")).toBeInTheDocument();
  });

  it("seeds the Requests off tab with the off weight when an off cell is present", () => {
    renderEditor({
      cells: [{ kind: "off", person: "kevin", date: "2026-01-05", weight: -5 }],
    });
    expect(screen.getByTestId("cell-editor-tab-off")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("cell-editor-off-weight-input")).toHaveValue("-5");
  });

  it("seeds per-target weights from request cells", () => {
    renderEditor({
      cells: [{ kind: "request", person: "kevin", date: "2026-01-05", shiftType: "PM", weight: 7 }],
    });
    expect(screen.getByTestId("cell-editor-weight-input-PM")).toHaveValue("7");
    expect(screen.getByTestId("cell-editor-weight-input-AM")).toHaveValue("0");
  });
});

describe("CellPreferenceEditor — save (strict XOR, FR-SR-17/21-23)", () => {
  it("Save on the Leave tab emits kind:'leave' and closes", () => {
    const { onSave, onClose } = renderEditor();
    fireEvent.click(screen.getByTestId("cell-editor-tab-leave"));
    fireEvent.click(screen.getByTestId("cell-editor-save"));
    expect(onSave).toHaveBeenCalledWith({ kind: "leave" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Save on the Requests off tab with a nonzero weight emits kind:'off' with that weight", () => {
    const { onSave } = renderEditor();
    fireEvent.click(screen.getByTestId("cell-editor-tab-off"));
    fireEvent.change(screen.getByTestId("cell-editor-off-weight-input"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByTestId("cell-editor-save"));
    expect(onSave).toHaveBeenCalledWith({ kind: "off", weight: 3 });
  });

  it("Save on the Requests off tab with weight 0 omits the weight field", () => {
    const { onSave } = renderEditor();
    fireEvent.click(screen.getByTestId("cell-editor-tab-off"));
    fireEvent.click(screen.getByTestId("cell-editor-save"));
    expect(onSave).toHaveBeenCalledWith({ kind: "off", weight: undefined });
  });

  it("Save on Available builds prefs only for nonzero weights", () => {
    const { onSave } = renderEditor();
    fireEvent.change(screen.getByTestId("cell-editor-weight-input-AM"), {
      target: { value: "5" },
    });
    fireEvent.click(screen.getByTestId("cell-editor-save"));
    expect(onSave).toHaveBeenCalledWith({
      kind: "requests",
      prefs: [{ shiftType: "AM", weight: 5 }],
    });
  });

  it("Save on Available with every weight 0 emits an empty prefs array (no crash)", () => {
    const { onSave } = renderEditor();
    fireEvent.click(screen.getByTestId("cell-editor-save"));
    expect(onSave).toHaveBeenCalledWith({ kind: "requests", prefs: [] });
  });

  it("blocks Save with the verbatim invalid-weight guard when a weight is unparseable", () => {
    const { onSave, onClose } = renderEditor();
    fireEvent.change(screen.getByTestId("cell-editor-weight-input-AM"), {
      target: { value: "not-a-number" },
    });
    fireEvent.click(screen.getByTestId("cell-editor-save"));
    expect(screen.getByTestId("cell-editor-error")).toHaveTextContent(
      "Weight must be a valid number, Infinity, or -Infinity",
    );
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("blocks Save with the verbatim invalid-weight guard on the Off tab too", () => {
    const { onSave } = renderEditor();
    fireEvent.click(screen.getByTestId("cell-editor-tab-off"));
    fireEvent.change(screen.getByTestId("cell-editor-off-weight-input"), {
      target: { value: "garbage" },
    });
    fireEvent.click(screen.getByTestId("cell-editor-save"));
    expect(screen.getByTestId("cell-editor-error")).toHaveTextContent(
      "Weight must be a valid number, Infinity, or -Infinity",
    );
    expect(onSave).not.toHaveBeenCalled();
  });

  it("accepts ∞ as a valid weight", () => {
    const { onSave } = renderEditor();
    fireEvent.change(screen.getByTestId("cell-editor-weight-input-AM"), {
      target: { value: "∞" },
    });
    fireEvent.click(screen.getByTestId("cell-editor-save"));
    expect(onSave).toHaveBeenCalledWith({
      kind: "requests",
      prefs: [{ shiftType: "AM", weight: Infinity }],
    });
  });
});

describe("CellPreferenceEditor — clear cell / cancel", () => {
  it("Clear cell calls onClear then onClose", () => {
    const { onClear, onClose } = renderEditor();
    fireEvent.click(screen.getByTestId("cell-editor-clear"));
    expect(onClear).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Cancel calls onClose without saving or clearing", () => {
    const { onSave, onClear, onClose } = renderEditor();
    fireEvent.click(screen.getByTestId("cell-editor-cancel"));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
  });
});
