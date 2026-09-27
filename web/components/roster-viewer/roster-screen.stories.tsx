import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, screen, waitFor } from "storybook/test";
import { resetRosterCaptureGate } from "@/lib/optimize";
import type { RosterDocument } from "@/lib/roster";
import { fixtureAlternateRosterDocument, fixtureRosterDocument } from "@/lib/roster/test-fixtures";
import { ROSTER_VIEW_PREFERENCE_KEY } from "@/lib/roster-viewer";
import { getRosterDb, rosterStorage, WORKING_ROSTER_KEY } from "@/lib/store";
import { RosterScreen } from "./roster-screen";

// THE SINGLE WRITER (w0e.6 plan, D4): the app-singleton `rosterStorage` is bound to the
// default roster database, so this is the only story file that writes through it. Every
// story starts and ends with that database cleared. Covers RosterSection and
// WorkingRosterPanel, which this zero-prop screen mounts for real.

async function seedWorking(): Promise<void> {
  const document = await fixtureRosterDocument();
  const outcome = await rosterStorage.promoteDocumentToWorking({
    document,
    validate: (value) => ({ ok: true as const, document: value as RosterDocument }),
    expectedWorkingRevision: null,
    expectedClearEpoch: await rosterStorage.getClearEpoch(),
  });
  if (outcome.status !== "promoted") throw new Error(`seed failed: ${outcome.status}`);
}

// A durable candidate with no working roster behind it (roster-section.test.tsx `seedCandidate`).
async function seedCandidate(): Promise<void> {
  const outcome = await rosterStorage.commitCandidate({
    jobId: "opt_candidate_a",
    submissionOrdinal: 1,
    document: await fixtureAlternateRosterDocument(),
    expectedClearEpoch: await rosterStorage.getClearEpoch(),
  });
  if (outcome.status !== "committed") throw new Error(`seed failed: ${outcome.status}`);
  if (outcome.working.kind === "loaded-empty") {
    await getRosterDb().roster.delete(WORKING_ROSTER_KEY);
  }
}

const meta = {
  title: "RosterViewer/RosterScreen",
  component: RosterScreen,
  parameters: {
    scenario: "empty",
    layout: "fullscreen",
    nextjs: { appDirectory: true, navigation: { pathname: "/roster" } },
  },
  beforeEach: async () => {
    resetRosterCaptureGate();
    localStorage.removeItem(ROSTER_VIEW_PREFERENCE_KEY);
    await rosterStorage.clearRosterData();
    return async () => {
      await rosterStorage.clearRosterData();
      resetRosterCaptureGate();
    };
  },
} satisfies Meta<typeof RosterScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

// An edit autosaves through the durable working roster.
export const Working: Story = {
  beforeEach: seedWorking,
  play: async ({ canvas, userEvent }) => {
    await expect(await canvas.findByTestId("roster-viewer")).toBeVisible();
    // Editing arms once the working roster's save authority is ready.
    const cell = (await canvas.findAllByRole("button", { name: /^Alice Ng / }))[0]!;
    await userEvent.click(cell);
    await userEvent.click(await canvas.findByTestId("roster-edit-option-OFF"));
    await waitFor(() => expect(canvas.getByTestId("roster-save-saved")).toBeVisible());
    const saved = await rosterStorage.readWorking<RosterDocument>();
    await expect(saved?.document.edits).toContainEqual({
      personIdx: 0,
      dateIdx: 0,
      day: { kind: "off" },
    });
  },
};

export const CandidateAvailable: Story = {
  beforeEach: seedCandidate,
  play: async ({ canvas, userEvent }) => {
    const offer = await canvas.findByTestId("roster-candidate-available");
    await waitFor(() => expect(offer).toBeVisible());
    await userEvent.click(canvas.getByTestId("roster-candidate-load"));
    await expect(await canvas.findByTestId("roster-viewer")).toBeVisible();
  },
};

export const ClearRoster: Story = {
  beforeEach: seedWorking,
  play: async ({ canvas, userEvent }) => {
    await expect(await canvas.findByTestId("roster-viewer")).toBeVisible();
    await userEvent.click(canvas.getByTestId("roster-clear"));
    const confirm = await screen.findByRole("button", { name: "Clear all roster data" });
    await waitFor(() => expect(confirm).toBeVisible());
    await userEvent.click(confirm);
    await expect(await canvas.findByTestId("roster-section-empty")).toBeVisible();
  },
};

// Declared AFTER Working: proves the previous story's roster did not survive.
export const Empty: Story = {
  play: async ({ canvas }) => {
    await expect(await canvas.findByTestId("roster-section-empty")).toBeVisible();
    await expect(canvas.getByText("No roster loaded yet")).toBeVisible();
    await expect(canvas.getByTestId("roster-empty-actions")).toBeVisible();
  },
};

export const Dark: Story = {
  beforeEach: seedWorking,
  globals: { theme: "dark" },
  play: async ({ canvas }) => {
    await expect(await canvas.findByTestId("roster-viewer")).toBeVisible();
  },
};
