// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createEmptyScenarioUiState } from "@/lib/scenario";
import {
  drainScenarioPersist,
  pickScenario,
  resetToNewScenario,
  useHotStore,
  useScenarioStore,
} from "@/lib/store";
import { StartOverCard } from "./new-schedule-button";

// Focused contract for the shared reset presenter. F2 is its sole VISUAL owner
// before F4 — R1 and R7 render it without editing it — so this pins both halves:
// the confirmation gate and the reset it drives (which must stay a real
// `resetToNewScenario` against the live store, not a mock), and the v2 surface
// reading it now publishes.
//
// The all-slices proof for `resetToNewScenario` itself lives in reset.test.ts;
// what is proved here is that the BUTTON reaches it only through a confirm.

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function classesOf(element: Element | null): string {
  return element?.getAttribute("class") ?? "";
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetToNewScenario(useScenarioStore, useHotStore);
  await drainScenarioPersist(useScenarioStore);
});

afterEach(() => {
  cleanup();
});

function seedDirtyScenario() {
  useScenarioStore.getState().mutateScenario({
    rangeStart: "2026-03-01",
    rangeEnd: "2026-03-31",
    staff: [{ _k: "p1", id: 1, description: "Nurse A" }],
  });
}

describe("StartOverCard — the confirmation gate", () => {
  it("does not touch the scenario until the destructive action is confirmed", async () => {
    seedDirtyScenario();
    render(<StartOverCard />);

    fireEvent.click(screen.getByTestId("new-schedule-button"));
    // The dialog is open; nothing has been reset yet.
    expect(await screen.findByTestId("confirm-dialog-confirm")).toBeInTheDocument();
    expect(useScenarioStore.getState().staff).toHaveLength(1);

    fireEvent.click(screen.getByTestId("confirm-dialog-cancel"));
    expect(useScenarioStore.getState().staff).toHaveLength(1);
  });

  it("resets every scenario slice on confirm and reports completion", async () => {
    seedDirtyScenario();
    const onResetComplete = vi.fn();
    render(<StartOverCard onResetComplete={onResetComplete} />);

    fireEvent.click(screen.getByTestId("new-schedule-button"));
    fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));

    await waitFor(() => {
      expect(pickScenario(useScenarioStore.getState())).toEqual(
        pickScenario(createEmptyScenarioUiState()),
      );
    });
    await waitFor(() => expect(onResetComplete).toHaveBeenCalledOnce());

    const { toast } = await import("sonner");
    expect(toast.success).toHaveBeenCalledWith("New schedule created");
  });

  it("names the consequences in the confirmation rather than only the verb", async () => {
    render(<StartOverCard />);
    fireEvent.click(screen.getByTestId("new-schedule-button"));
    const consequences = await screen.findByTestId("confirm-dialog-consequences");
    expect(consequences).toHaveTextContent("All people, shift types and dates");
    expect(consequences).toHaveTextContent("Every rule and request");
  });
});

describe("StartOverCard — v2 surface reading", () => {
  it("is an ordinary L1 card, with the destructive signal on the ACTION", () => {
    render(<StartOverCard />);
    const card = classesOf(screen.getByTestId("start-over-card"));
    expect(card).toContain("bg-surface");
    expect(card).toContain("border-line");
    expect(card).toContain("shadow-1");
    expect(card).toContain("rounded-card");
    // v1 outlined the whole card in --error; v2 does not shout at the resting state.
    expect(card).not.toContain("border-error");
  });

  it("uses the shared destructive-outline Button, with no local colour override", () => {
    render(<StartOverCard />);
    const button = screen.getByTestId("new-schedule-button");
    expect(button).toHaveAttribute("data-slot", "button");
    const classes = classesOf(button);
    expect(classes).toContain("border-error");
    expect(classes).toContain("text-errorink");
    expect(classes).toContain("hover:bg-errortint");
    // Pill, and a real 44px target on a coarse pointer — both from the primitive.
    expect(classes).toContain("rounded-pill");
    expect(classes).toContain("pointer-coarse:min-h-touch");
    expect(classes).toContain("pointer-coarse:min-w-touch");
  });
});
