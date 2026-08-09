// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createEmptyScenarioUiState } from "@/lib/scenario";
import {
  drainScenarioPersist,
  pickScenario,
  resetToNewScenario,
  rosterStorage,
  useHotStore,
  useScenarioStore,
} from "@/lib/store";
import { NEW_SCHEDULE_FAILED_MESSAGE } from "@/lib/roster";
import type { RosterDocument } from "@/lib/roster";
import { fixtureRosterDocument } from "@/lib/roster/test-fixtures";
import { StartOverCard } from "./new-schedule-button";

// Focused contract for the shared reset presenter. F2 is its sole VISUAL owner
// before F4 — R1 and R7 render it without editing it — so this pins both halves:
// the confirmation gate and the reset it drives (which must stay a real
// `resetToNewSchedule` against the live store and the live roster storage, not a
// mock), and the v2 surface reading it now publishes.
//
// The all-slices proof for `resetToNewScenario` itself lives in reset.test.ts, and
// the fail-closed ordering proof in `lib/roster/new-schedule-reset.test.ts`; what
// is proved here is that the BUTTON reaches the reset only through a confirm, that
// the reset it reaches genuinely removes the previous run's roster data, and that
// an unverified cut is never announced as `New schedule created`.

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

  it("clears the previous run's roster data, not only the scenario", async () => {
    // The defect this closes: a confirmed reset used to leave the working roster,
    // the durable candidate and its pointer in place, so Optimize kept announcing
    // the previous run's capture outcome inside a supposedly new schedule.
    const document = await fixtureRosterDocument();
    const epoch = await rosterStorage.getClearEpoch();
    const commit = await rosterStorage.commitCandidate<RosterDocument>({
      jobId: "job-stale",
      submissionOrdinal: 1,
      document,
      expectedClearEpoch: epoch,
    });
    expect(commit.status).toBe("committed");
    expect(await rosterStorage.readWorking<RosterDocument>()).not.toBeNull();

    seedDirtyScenario();
    render(<StartOverCard />);
    fireEvent.click(screen.getByTestId("new-schedule-button"));
    fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));

    const { toast } = await import("sonner");
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("New schedule created"));
    expect(await rosterStorage.readWorking<RosterDocument>()).toBeNull();
    expect(await rosterStorage.readCandidate<RosterDocument>("job-stale")).toBeNull();
    expect(await rosterStorage.readCurrentCandidate()).toBeNull();
  });

  it("never claims New schedule created when the stored-data cut is unverified", async () => {
    seedDirtyScenario();
    const onResetComplete = vi.fn();
    render(
      <StartOverCard
        onResetComplete={onResetComplete}
        resetNewSchedule={async () => ({
          status: "failed",
          failure: "stored-data",
          storedData: null,
        })}
      />,
    );

    fireEvent.click(screen.getByTestId("new-schedule-button"));
    fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));

    const { toast } = await import("sonner");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(NEW_SCHEDULE_FAILED_MESSAGE));
    expect(toast.success).not.toHaveBeenCalled();
    expect(onResetComplete).not.toHaveBeenCalled();
    // The workspace is intact, so clicking New schedule again is a real retry — and
    // the card (with its button) is still on screen to click.
    expect(useScenarioStore.getState().staff).toHaveLength(1);
    expect(screen.getByTestId("new-schedule-button")).toBeInTheDocument();
  });

  it("names the consequences in the confirmation rather than only the verb", async () => {
    render(<StartOverCard />);
    fireEvent.click(screen.getByTestId("new-schedule-button"));
    const consequences = await screen.findByTestId("confirm-dialog-consequences");
    expect(consequences).toHaveTextContent("All people, shift types and dates");
    expect(consequences).toHaveTextContent("Every rule and request");
    // The reset now removes the previous run's roster too, so the confirmation has
    // to say so — the consequence list is the only place the user is told.
    expect(consequences).toHaveTextContent("The saved roster and the last run's result");
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
