// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createEmptyScenarioUiState, serializeScenario } from "@/lib/scenario";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
// INTEGRATION: `drainScenarioPersist` and the direct `resetToNewScenario` import are
// gone — the persist seam was retired by T03, and this suite drives the reset through
// the product's `resetToNewSchedule` and the test authority instead.
import {
  currentRosterStorage,
  pickScenario,
  rosterStorageFor,
  scenarioCommands,
  useAuthorityStore,
  useScenarioStore,
} from "@/lib/store";
import { NEW_SCHEDULE_FAILED_MESSAGE } from "@/lib/roster";
import type { RosterDocument } from "@/lib/roster";
import { fixtureRosterDocument } from "@/lib/roster/test-fixtures";
import { EXAMPLE_SCHEDULE_FAILED_MESSAGE, StartOverCard } from "./new-schedule-button";
import {
  drainScenarioCommands,
  mirrorOpenScheduleForRoster,
  resetScenarioForTest,
} from "@/lib/store/test-authority";

// Focused contract for the shared reset presenter. F2 is its sole VISUAL owner
// before F4 — R1 and R7 render it without editing it — so this pins both halves:
// the confirmation gate and the reset it drives (which must stay a real
// `resetToNewSchedule` against the live store and the live roster storage, not a
// mock), and the v2 surface reading it now publishes.
//
// The all-slices proof for `resetToNewScenario` itself lives in reset.test.ts, and
// the fail-closed ordering proof in `lib/roster/new-schedule-reset.test.ts`; what
// is proved here is that the BUTTON reaches the reset only through a confirm, that
// the previous schedule keeps its own roster (plq5 P2) while the new one has none,
// and that an unverified cut is never announced as `New schedule created`.

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function classesOf(element: Element | null): string {
  return element?.getAttribute("class") ?? "";
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetScenarioForTest();
  await drainScenarioCommands();
});

afterEach(async () => {
  cleanup();
});

async function seedDirtyScenario() {
  await scenarioCommands.mutate({
    rangeStart: "2026-03-01",
    rangeEnd: "2026-03-31",
    staff: [{ _k: "p1", id: 1, description: "Nurse A" }],
  });
}

describe("StartOverCard — the confirmation gate", () => {
  it("does not touch the scenario until the destructive action is confirmed", async () => {
    await seedDirtyScenario();
    render(<StartOverCard />);

    fireEvent.click(screen.getByTestId("new-schedule-button"));
    // The dialog is open; nothing has been reset yet.
    expect(await screen.findByTestId("confirm-dialog-confirm")).toBeInTheDocument();
    expect(useScenarioStore.getState().staff).toHaveLength(1);

    fireEvent.click(screen.getByTestId("confirm-dialog-cancel"));
    expect(useScenarioStore.getState().staff).toHaveLength(1);
  });

  it("resets every scenario slice on confirm and reports completion", async () => {
    await seedDirtyScenario();
    const onResetComplete = vi.fn();
    render(<StartOverCard onResetComplete={onResetComplete} />);

    fireEvent.click(screen.getByTestId("new-schedule-button"));
    fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));

    await waitFor(() => {
      expect(pickScenario(useScenarioStore.getState())).toEqual(
        pickScenario(createEmptyScenarioUiState()),
      );
    });
    await waitFor(async () => expect(onResetComplete).toHaveBeenCalledOnce());

    const { toast } = await import("sonner");
    expect(toast.success).toHaveBeenCalledWith("New schedule created");
  });

  it("keeps the previous schedule's roster with it; the new schedule starts with none (plq5 P2)", async () => {
    // Each schedule keeps its own roster, so New neither shows the previous roster in
    // the new schedule nor deletes it: reopening the old schedule brings it back.
    await mirrorOpenScheduleForRoster();
    const previous = useAuthorityStore.getState().scenarioId!;
    const storage = currentRosterStorage();
    const document = await fixtureRosterDocument();
    const epoch = await storage.getClearEpoch();
    const commit = await storage.commitCandidate<RosterDocument>({
      jobId: "job-stale",
      submissionOrdinal: 1,
      document,
      expectedClearEpoch: epoch,
    });
    expect(commit.status).toBe("committed");
    expect(await storage.readWorking<RosterDocument>()).not.toBeNull();

    // AWAITED. Pre-T03 this seed was a synchronous `mutateScenario`; it is a durable
    // repository command now, so leaving the promise floating both races the assertion
    // below and lets the commit land inside a LATER test.
    await seedDirtyScenario();
    render(<StartOverCard />);
    fireEvent.click(screen.getByTestId("new-schedule-button"));
    fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));

    const { toast } = await import("sonner");
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("New schedule created"));
    expect(useAuthorityStore.getState().scenarioId).not.toBe(previous);
    expect(await currentRosterStorage().readWorking<RosterDocument>()).toBeNull();
    expect(await currentRosterStorage().readCurrentCandidate()).toBeNull();
    const kept = rosterStorageFor(previous);
    expect(await kept.readWorking<RosterDocument>()).not.toBeNull();
    expect(await kept.readCandidate<RosterDocument>("job-stale")).not.toBeNull();
    expect((await kept.readCurrentCandidate())?.jobId).toBe("job-stale");
  });

  it("never claims New schedule created when the stored-data cut is unverified", async () => {
    // AWAITED — see the note above; the `staff` assertion at the end reads the
    // projection this command publishes.
    await seedDirtyScenario();
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

  it("tells the user about the OTHER TAB when the scenario reset is refused", async () => {
    // INTEGRATION (T03). The scenario half is a repository command over a leased
    // authority now, so the commonest real refusal is `not-owner`: another tab holds
    // the lease. That is the one refusal the user can actually act on, so it must not
    // be flattened into the generic "some data may still be stored" message, which
    // names a cause that did not happen and offers a retry that cannot succeed.
    //
    // The generic arm above is what makes this non-vacuous: both are failures, and the
    // card tells them apart by `scenarioReason` rather than by status alone.
    await seedDirtyScenario();
    const onResetComplete = vi.fn();
    render(
      <StartOverCard
        onResetComplete={onResetComplete}
        resetNewSchedule={async () => ({
          status: "failed",
          failure: "scenario",
          storedData: null,
          scenarioReason: "not-owner",
        })}
      />,
    );

    fireEvent.click(screen.getByTestId("new-schedule-button"));
    fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));

    const { toast } = await import("sonner");
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "This schedule is being edited in another tab. Take over editing, then start over.",
      ),
    );
    expect(toast.error).not.toHaveBeenCalledWith(NEW_SCHEDULE_FAILED_MESSAGE);
    expect(toast.success).not.toHaveBeenCalled();
    expect(onResetComplete).not.toHaveBeenCalled();
  });

  it("claims nothing is cleared: the schedule and its roster stay in Recent schedules (plq5)", async () => {
    render(<StartOverCard />);
    fireEvent.click(screen.getByTestId("new-schedule-button"));
    const dialog = await screen.findByRole("alertdialog", { name: "Start a new schedule?" });
    expect(dialog).toHaveTextContent(
      "Your current schedule stays in Recent schedules, with its roster",
    );
    expect(dialog).not.toHaveTextContent("cannot be undone");
    expect(screen.queryByTestId("confirm-dialog-consequences")).toBeNull();
    expect(screen.getByTestId("start-over-card")).not.toHaveTextContent("removes everything");
  });
});

describe("StartOverCard — v2 surface reading", async () => {
  it("is an ordinary L1 card, with the destructive signal on the ACTION", async () => {
    render(<StartOverCard />);
    const card = classesOf(screen.getByTestId("start-over-card"));
    expect(card).toContain("bg-surface");
    expect(card).toContain("border-line");
    expect(card).toContain("shadow-1");
    expect(card).toContain("rounded-card");
    // v1 outlined the whole card in --error; v2 does not shout at the resting state.
    expect(card).not.toContain("border-error");
  });

  it("uses the shared destructive-outline Button, with no local colour override", async () => {
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

// ---------------------------------------------------------------------------
// F07 — the 87-person example choice. The example is deliberately NOT a second
// reset protocol: it rides the SAME inbound pipeline as Upload and Edit-YAML
// (`prepareScenarioLoad` → replacement/version confirm → `loadScenario`), so these
// prove the card reaches that pipeline and its shared confirm / issue / warning
// surfaces instead of inventing a parallel one.
// ---------------------------------------------------------------------------

/** A backend-valid YAML the example seam returns in place of the bundled file. */
const EXAMPLE_YAML = serializeScenario(makeValidUiState());
const SCENARIO_LOADED = "Scenario loaded — this replaces your current setup.";

async function snapshot() {
  await drainScenarioCommands();
  return pickScenario(useScenarioStore.getState());
}

describe("StartOverCard — the 87-person example", () => {
  it("offers both choices on the card", () => {
    render(<StartOverCard />);
    expect(screen.getByTestId("new-schedule-button")).toHaveTextContent("New schedule");
    expect(screen.getByTestId("new-schedule-example")).toHaveTextContent("87-person example");
  });

  it("loads the example through the shared import path, reusing its replacement confirm", async () => {
    await seedDirtyScenario();

    render(<StartOverCard fetchExampleSchedule={async () => EXAMPLE_YAML} />);
    fireEvent.click(screen.getByTestId("new-schedule-example"));

    // The path's own replacement confirmation, not a bespoke dialog — and nothing
    // is replaced until it is continued through.
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await waitFor(async () => {
      expect((await snapshot()).staff.map((person) => person.id)).toEqual(["Alice", "Bob"]);
    });
  });

  it("keeps the current schedule when the example file cannot be fetched", async () => {
    await seedDirtyScenario();
    const before = await snapshot();

    render(
      <StartOverCard
        fetchExampleSchedule={async () => {
          throw new Error("network down");
        }}
      />,
    );
    fireEvent.click(screen.getByTestId("new-schedule-example"));

    expect(await screen.findByTestId("new-schedule-example-error")).toHaveTextContent(
      EXAMPLE_SCHEDULE_FAILED_MESSAGE,
    );
    expect(screen.getByTestId("new-schedule-example")).not.toBeDisabled();
    expect(await snapshot()).toEqual(before);
  });

  it("keeps the current schedule and shows the load issues when the example cannot be imported", async () => {
    await seedDirtyScenario();
    const before = await snapshot();

    render(<StartOverCard fetchExampleSchedule={async () => "::not a scenario::"} />);
    fireEvent.click(screen.getByTestId("new-schedule-example"));

    expect(await screen.findByTestId("scenario-export-issues")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("new-schedule-example")).not.toBeDisabled());
    expect(await snapshot()).toEqual(before);
  });

  it("shows a loading state while the example is being fetched", async () => {
    let resolve!: (text: string) => void;
    const pending = new Promise<string>((r) => {
      resolve = r;
    });
    render(<StartOverCard fetchExampleSchedule={() => pending} />);

    fireEvent.click(screen.getByTestId("new-schedule-example"));
    await waitFor(() => expect(screen.getByTestId("new-schedule-example")).toBeDisabled());
    expect(screen.getByTestId("new-schedule-example")).toHaveTextContent("Loading");

    resolve(EXAMPLE_YAML);
    // 7vtc: busy until the load it hands off (the scenario switch) settles,
    // not merely the fetch — so re-enabling implies the load has finished.
    await waitFor(() => expect(screen.getByTestId("new-schedule-example")).not.toBeDisabled());
    const { toast } = await import("sonner");
    expect(toast.success).toHaveBeenCalledWith(SCENARIO_LOADED);
  });

  it("stays busy through the replacement confirm until the load finishes (7vtc)", async () => {
    await seedDirtyScenario();
    render(<StartOverCard fetchExampleSchedule={async () => EXAMPLE_YAML} />);

    fireEvent.click(screen.getByTestId("new-schedule-example"));
    const continueButton = await screen.findByRole("button", { name: "Continue" });
    // The fetch is done, the load is not: no second click may start a second load.
    expect(screen.getByTestId("new-schedule-example")).toBeDisabled();

    fireEvent.click(continueButton);
    await waitFor(() => expect(screen.getByTestId("new-schedule-example")).not.toBeDisabled());
    const { toast } = await import("sonner");
    expect(toast.success).toHaveBeenCalledWith(SCENARIO_LOADED);
  });

  it("re-enables when the replacement confirm is cancelled (7vtc)", async () => {
    await seedDirtyScenario();
    const before = await snapshot();
    render(<StartOverCard fetchExampleSchedule={async () => EXAMPLE_YAML} />);

    fireEvent.click(screen.getByTestId("new-schedule-example"));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.getByTestId("new-schedule-example")).not.toBeDisabled());
    expect(await snapshot()).toEqual(before);
  });

  it("rides the normal import path — the example never shows the previous roster (plq5 P2)", async () => {
    // The example does whatever a normal import does: a fresh schedule with no roster
    // of its own, while the schedule it replaces keeps its roster.
    await mirrorOpenScheduleForRoster();
    const previous = useAuthorityStore.getState().scenarioId!;
    const storage = currentRosterStorage();
    const document = await fixtureRosterDocument();
    const epoch = await storage.getClearEpoch();
    await storage.commitCandidate<RosterDocument>({
      jobId: "job-example",
      submissionOrdinal: 1,
      document,
      expectedClearEpoch: epoch,
    });

    render(<StartOverCard fetchExampleSchedule={async () => EXAMPLE_YAML} />);
    fireEvent.click(screen.getByTestId("new-schedule-example"));

    // THIS click's load completing (the switch), not merely Alice/Bob in the store.
    const { toast } = await import("sonner");
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(SCENARIO_LOADED));
    expect((await snapshot()).staff.map((person) => person.id)).toEqual(["Alice", "Bob"]);
    expect(await currentRosterStorage().readWorking<RosterDocument>()).toBeNull();
    expect(await currentRosterStorage().readCandidate<RosterDocument>("job-example")).toBeNull();
    expect(await rosterStorageFor(previous).readWorking<RosterDocument>()).not.toBeNull();
  });
});
