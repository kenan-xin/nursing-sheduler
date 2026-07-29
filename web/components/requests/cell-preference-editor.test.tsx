// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

// ---------------------------------------------------------------------------
// The shared-overlay half of the contract (F3). The editor holds a LOCAL draft,
// so what matters is that every cancel-like route discards it and only Save /
// Clear commit — exactly once each.
// ---------------------------------------------------------------------------

function classesOf(element: Element | null): string {
  return element?.getAttribute("class") ?? "";
}

describe("CellPreferenceEditor — the compact weight fields keep the control floor", () => {
  // F4's custom-spacing merge registration made the old `h-8.5` override newly
  // effective, and 8.5 × the 0.9-baked spacing unit is 30.6px — under the 32px
  // precise-pointer floor. These pin the CANONICAL token instead, so the same
  // regression cannot return through the spacing scale.
  const WEIGHT_INPUT_TESTIDS = [
    "cell-editor-weight-input-AM",
    "cell-editor-weight-input-PM",
    "cell-editor-weight-input-EARLY",
  ];

  it("sizes every per-target weight field with the canonical small-control token", () => {
    renderEditor();
    for (const testid of WEIGHT_INPUT_TESTIDS) {
      const input = screen.getByTestId(testid);
      expect(classesOf(input), testid).toContain("h-control-sm");
      // No spacing-scale height may size a control: `--spacing` carries the 0.9
      // density baseline, which is exactly what must not shrink a hit target.
      expect(classesOf(input), testid).not.toMatch(/(^|\s)h-\d/);
    }
  });

  it("sizes the OFF weight field with the same canonical token", () => {
    const { onSave } = renderEditor();
    fireEvent.click(screen.getByTestId("cell-editor-tab-off"));
    const input = screen.getByTestId("cell-editor-off-weight-input");
    expect(classesOf(input)).toContain("h-control-sm");
    expect(classesOf(input)).not.toMatch(/(^|\s)h-\d/);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("keeps the coarse-pointer floor the shared Input supplies", () => {
    renderEditor();
    // The override sets HEIGHT only; the primitive's `min-h-touch` still raises
    // the floor to a real 44px on a coarse pointer, and the two compose.
    for (const testid of WEIGHT_INPUT_TESTIDS) {
      expect(classesOf(screen.getByTestId(testid)), testid).toContain("pointer-coarse:min-h-touch");
    }
    fireEvent.click(screen.getByTestId("cell-editor-tab-off"));
    expect(classesOf(screen.getByTestId("cell-editor-off-weight-input"))).toContain(
      "pointer-coarse:min-h-touch",
    );
  });

  it("leaves the sibling weight-readout column untouched", () => {
    renderEditor();
    // The readout beside each field is a plain text column, not a control — its
    // spacing-scale width is correct and deliberately not swept up in this fix.
    const row = screen.getByTestId("cell-editor-weight-row-AM");
    expect(row.querySelector(".w-8\\.5")).not.toBeNull();
  });

  it("still parses and commits through the resized fields", () => {
    const { onSave } = renderEditor();
    fireEvent.change(screen.getByTestId("cell-editor-weight-input-AM"), {
      target: { value: "5" },
    });
    fireEvent.click(screen.getByTestId("cell-editor-save"));
    expect(onSave).toHaveBeenCalledExactlyOnceWith({
      kind: "requests",
      prefs: [{ shiftType: "AM", weight: 5 }],
    });
  });
});

describe("CellPreferenceEditor — shared overlay contract", () => {
  it("renders through the shared portal as an L2 raised card behind bg-scrim", () => {
    renderEditor();
    const popup = screen.getByTestId("cell-preference-editor");
    const overlay = document.querySelector("[data-slot='dialog-overlay']");
    expect(popup.closest("[data-slot='dialog-portal']")).not.toBeNull();
    expect(classesOf(popup)).toContain("bg-surface2");
    expect(classesOf(popup)).toContain("rounded-card");
    expect(classesOf(popup)).toContain("shadow-3");
    expect(classesOf(overlay)).toContain("bg-scrim");
    expect(classesOf(overlay)).not.toContain("bg-black");
  });

  it("names the coordinate through a real title and description", () => {
    renderEditor();
    const popup = screen.getByTestId("cell-preference-editor");
    expect(popup).toHaveAccessibleName("Cell preference");
    expect(popup).toHaveAccessibleDescription("1. Kevin Ong · 2026-01-05");
  });

  it("is a base-layer overlay", () => {
    renderEditor();
    expect(screen.getByTestId("cell-preference-editor")).toHaveAttribute("data-layer", "base");
  });
});

describe("CellPreferenceEditor — implicit dismissal discards the draft", () => {
  it("Escape discards: onClose fires, nothing is committed", async () => {
    const { onSave, onClear, onClose } = renderEditor();
    fireEvent.change(screen.getByTestId("cell-editor-weight-input-AM"), {
      target: { value: "5" },
    });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onSave).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
  });

  it("a backdrop press discards: onClose fires, nothing is committed", async () => {
    const { onSave, onClear, onClose } = renderEditor();
    fireEvent.click(screen.getByTestId("cell-editor-tab-leave"));
    const overlay = document.querySelector("[data-slot='dialog-overlay']") as HTMLElement;
    await userEvent.click(overlay);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSave).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
  });

  it("reopening reseeds from the live cells, so a discarded draft cannot survive", () => {
    const props = {
      personLabel: "1. Kevin Ong",
      dateLabel: "2026-01-05",
      cells: [] as UiRequestCell[],
      targets: TARGETS,
      onSave: vi.fn(),
      onClear: vi.fn(),
      onClose: vi.fn(),
    };
    const { rerender } = render(<CellPreferenceEditor open {...props} />);
    fireEvent.change(screen.getByTestId("cell-editor-weight-input-AM"), {
      target: { value: "9" },
    });
    rerender(<CellPreferenceEditor open={false} {...props} />);
    rerender(<CellPreferenceEditor open {...props} />);
    expect(screen.getByTestId("cell-editor-weight-input-AM")).toHaveValue("0");
  });

  it("Save and Clear each commit exactly once", () => {
    const save = renderEditor();
    fireEvent.click(screen.getByTestId("cell-editor-save"));
    expect(save.onSave).toHaveBeenCalledOnce();
    expect(save.onClear).not.toHaveBeenCalled();
    cleanup();

    const clear = renderEditor();
    fireEvent.click(screen.getByTestId("cell-editor-clear"));
    expect(clear.onClear).toHaveBeenCalledOnce();
    expect(clear.onSave).not.toHaveBeenCalled();
  });
});
