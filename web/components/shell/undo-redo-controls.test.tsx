// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useScenarioStore, scenarioCommands } from "@/lib/store";
import { UndoRedoControls } from "./undo-redo-controls";
import { resetScenarioForTest, drainScenarioCommands, undoDepth } from "@/lib/store/test-authority";

// F3's shell-shared trigger fix (fix-shell-coarse-targets) added the real
// coarse-pointer floor to these R1-owned controls; R1's v2 re-skin then replaced
// the hand-authored control with the shared Button recipe, which owns that floor
// as part of its base contract. This pins both halves: the geometry/elevation
// contract the recipe supplies, and the disabled-state / callback-cardinality
// contract the re-skin must not disturb.

function classesOf(element: Element | null): string {
  return element?.getAttribute("class") ?? "";
}

async function historyLength(): Promise<number> {
  await drainScenarioCommands();
  return undoDepth();
}

/**
 * Let a clicked control's durable command settle. T03: Undo and Redo are
 * repository COMMITS, so both the projection and the availability flags the
 * buttons read from land once the queued command has run.
 */
async function settle() {
  await act(async () => {
    await drainScenarioCommands();
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetScenarioForTest();
  await drainScenarioCommands();
});

afterEach(() => cleanup());

describe("UndoRedoControls — v2 control contract", () => {
  it("uses the absolute 36px icon-control box, not a spacing-derived one", async () => {
    render(<UndoRedoControls />);
    for (const testId of ["undo-button", "redo-button"]) {
      const classes = classesOf(screen.getByTestId(testId));
      // `size-control` resolves to --ctl (36px). `size-9` would resolve through
      // --spacing, which carries the 0.9 density baseline, to 32.4px — and
      // DESIGN.md is explicit that control sizes are absolute and are NOT
      // multiplied by that baseline.
      expect(classes).toContain("size-control");
      expect(classes).not.toContain("size-9");
    }
  });

  it("keeps the real coarse-pointer floor on both buttons", async () => {
    render(<UndoRedoControls />);
    for (const testId of ["undo-button", "redo-button"]) {
      const classes = classesOf(screen.getByTestId(testId));
      // The real control grows via Tailwind's `pointer-coarse` variant — never a
      // pseudo-element hitbox or a hardcoded 44px arbitrary value.
      expect(classes).toContain("pointer-coarse:min-h-touch");
      expect(classes).toContain("pointer-coarse:min-w-touch");
    }
  });

  it("is the L1 secondary treatment — a real surface fill, hairline and resting shadow", async () => {
    render(<UndoRedoControls />);
    const classes = classesOf(screen.getByTestId("undo-button"));
    // DESIGN.md §4 rule 4: a transparent outlined button on the recessed page
    // does not read as pressable, so these are --surface + --line + --sh-1, and
    // the shadow drops on :active.
    expect(classes).toContain("bg-surface");
    expect(classes).toContain("border-line");
    expect(classes).toContain("shadow-1");
    expect(classes).toContain("active:shadow-none");
    expect(classes).toContain("rounded-pill");
  });
});

describe("UndoRedoControls — disabled state and undo/redo cardinality (unchanged by the coarse-pointer fix)", () => {
  it("disables both controls when there is no history", async () => {
    render(<UndoRedoControls />);
    expect(screen.getByTestId("undo-button")).toBeDisabled();
    expect(screen.getByTestId("redo-button")).toBeDisabled();
  });

  it("enables Undo after a tracked mutation, and Undo/Redo move exactly one step", async () => {
    render(<UndoRedoControls />);
    await act(async () => {
      await scenarioCommands.mutate({
        staff: [{ _k: "p1", id: 1, description: "Nurse A" }],
      });
    });
    expect(screen.getByTestId("undo-button")).not.toBeDisabled();
    expect(screen.getByTestId("redo-button")).toBeDisabled();

    const before = await historyLength();
    fireEvent.click(screen.getByTestId("undo-button"));
    await settle();
    expect(await historyLength()).toBe(before - 1);
    expect(useScenarioStore.getState().staff).toHaveLength(0);
    expect(screen.getByTestId("redo-button")).not.toBeDisabled();

    fireEvent.click(screen.getByTestId("redo-button"));
    await settle();
    expect(useScenarioStore.getState().staff).toHaveLength(1);
    expect(screen.getByTestId("redo-button")).toBeDisabled();
  });
});
