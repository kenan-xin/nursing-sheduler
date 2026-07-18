// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QuickPaintPanel, type PaintTarget } from "./quick-paint-panel";

afterEach(() => cleanup());

const TARGETS: PaintTarget[] = [
  { id: "AM", name: "Morning" },
  { id: "PM", name: "Evening" },
  { id: "OFF", name: "Off / rest day" },
];

describe("QuickPaintPanel", () => {
  it("renders a chip per target and toggles on click", () => {
    const onToggle = vi.fn();
    render(
      <QuickPaintPanel
        targets={TARGETS}
        selectedIds={[]}
        onToggle={onToggle}
        weight="5"
        onWeightChange={vi.fn()}
        onSetPosInf={vi.fn()}
        onSetNegInf={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("quick-paint-chip-AM"));
    expect(onToggle).toHaveBeenCalledWith("AM");
  });

  it("shows the clear-tone status line when nothing is selected", () => {
    render(
      <QuickPaintPanel
        targets={TARGETS}
        selectedIds={[]}
        onToggle={vi.fn()}
        weight="5"
        onWeightChange={vi.fn()}
        onSetPosInf={vi.fn()}
        onSetNegInf={vi.fn()}
      />,
    );
    expect(screen.getByTestId("quick-paint-status")).toHaveTextContent(
      "Drag over cells to clear existing requests or history.",
    );
  });

  it("shows the apply-tone status line for a selected target and valid weight", () => {
    render(
      <QuickPaintPanel
        targets={TARGETS}
        selectedIds={["AM"]}
        onToggle={vi.fn()}
        weight="5"
        onWeightChange={vi.fn()}
        onSetPosInf={vi.fn()}
        onSetNegInf={vi.fn()}
      />,
    );
    expect(screen.getByTestId("quick-paint-status")).toHaveTextContent(
      "Drag over cells to apply AM with weight +5.",
    );
  });

  it("wires the weight input and ±∞ buttons", () => {
    const onWeightChange = vi.fn();
    const onSetPosInf = vi.fn();
    const onSetNegInf = vi.fn();
    render(
      <QuickPaintPanel
        targets={TARGETS}
        selectedIds={["AM"]}
        onToggle={vi.fn()}
        weight="5"
        onWeightChange={onWeightChange}
        onSetPosInf={onSetPosInf}
        onSetNegInf={onSetNegInf}
      />,
    );
    fireEvent.change(screen.getByTestId("quick-paint-weight-input"), { target: { value: "9" } });
    fireEvent.click(screen.getByTestId("quick-paint-pos-inf"));
    fireEvent.click(screen.getByTestId("quick-paint-neg-inf"));
    expect(onWeightChange).toHaveBeenCalledWith("9");
    expect(onSetPosInf).toHaveBeenCalledOnce();
    expect(onSetNegInf).toHaveBeenCalledOnce();
  });
});
