// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  drainScenarioPersist,
  resetToNewScenario,
  useHotStore,
  useScenarioStore,
} from "@/lib/store";
import { UndoRedoControls } from "./undo-redo-controls";

// F3's shell-shared trigger fix (fix-shell-coarse-targets) adds the real
// coarse-pointer floor to these R1-owned controls without touching R1's
// precise-pointer geometry, disabled semantics, or undo/redo wiring. This
// pins both halves: the coarse-pointer contract this ticket adds, and the
// existing disabled-state/callback-cardinality contract it must not disturb.

function classesOf(element: Element | null): string {
  return element?.getAttribute("class") ?? "";
}

function historyLength(): number {
  return useScenarioStore.temporal.getState().pastStates.length;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetToNewScenario(useScenarioStore, useHotStore);
  await drainScenarioPersist(useScenarioStore);
});

afterEach(() => cleanup());

describe("UndoRedoControls — coarse-pointer contract", () => {
  it("keeps the precise ~32px control box and adds the real coarse-pointer floor on both buttons", () => {
    render(<UndoRedoControls />);
    for (const testId of ["undo-button", "redo-button"]) {
      const classes = classesOf(screen.getByTestId(testId));
      // Precise-pointer geometry is untouched: still the compact size-9 box.
      expect(classes).toContain("size-9");
      // The real control grows via Tailwind's `pointer-coarse` variant — never a
      // pseudo-element hitbox or a hardcoded 44px arbitrary value.
      expect(classes).toContain("pointer-coarse:min-h-touch");
      expect(classes).toContain("pointer-coarse:min-w-touch");
    }
  });
});

describe("UndoRedoControls — disabled state and undo/redo cardinality (unchanged by the coarse-pointer fix)", () => {
  it("disables both controls when there is no history", () => {
    render(<UndoRedoControls />);
    expect(screen.getByTestId("undo-button")).toBeDisabled();
    expect(screen.getByTestId("redo-button")).toBeDisabled();
  });

  it("enables Undo after a tracked mutation, and Undo/Redo move exactly one step", () => {
    render(<UndoRedoControls />);
    act(() => {
      useScenarioStore.getState().mutateScenario({
        staff: [{ _k: "p1", id: 1, description: "Nurse A" }],
      });
    });
    expect(screen.getByTestId("undo-button")).not.toBeDisabled();
    expect(screen.getByTestId("redo-button")).toBeDisabled();

    const before = historyLength();
    fireEvent.click(screen.getByTestId("undo-button"));
    expect(historyLength()).toBe(before - 1);
    expect(useScenarioStore.getState().staff).toHaveLength(0);
    expect(screen.getByTestId("redo-button")).not.toBeDisabled();

    fireEvent.click(screen.getByTestId("redo-button"));
    expect(useScenarioStore.getState().staff).toHaveLength(1);
    expect(screen.getByTestId("redo-button")).toBeDisabled();
  });
});
