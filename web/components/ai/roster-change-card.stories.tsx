import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn } from "storybook/test";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { SENTINEL_KEY } from "@/lib/ai/assistant/test-support";
import { withFetchRoutes } from "../../.storybook/story-helpers";
import { withAssistant } from "./assistant-story-harness.test-support";
import { RosterChangeCard } from "./roster-change-card";

// The swap card, seeded through the store with roster-change-card.test.tsx's CHANGE.
// Apply is OUT OF SCOPE here: it opens the Roster screen, whose working roster only
// roster-screen.stories.tsx may write (the single-writer rule). Plays stop short of it.
type Change = Parameters<typeof assistantActions.showRosterChange>[0];

const CHANGE: Change = {
  request: {
    solvedBaselineId: "a".repeat(64),
    cells: [
      {
        personIdx: 0,
        dateIdx: 1,
        before: { kind: "shift", shiftId: "N12" },
        after: { kind: "off" },
      },
    ],
  },
  view: {
    heading: "Swap shifts?",
    stepLabel: "Step 1 · Swap or cover within the ward",
    leaveRows: [],
    notes: [],
    agreement: null,
    title: "SN-Priya and SN-Cara, 8 Oct",
    summary: "Priya needs that night off.",
    rows: [
      { person: "SN-Priya", date: "8 Oct", now: "N12", after: "Day off" },
      { person: "SN-Cara", date: "8 Oct", now: "Day off", after: "N12" },
    ],
    worthKnowing: ["SN-Cara asked not to have a night shift on 8 Oct."],
    notChecked: [],
  },
};

const show = (change: Change) => () => {
  assistantActions.showRosterChange(change, useAssistantStore.getState().turnEpoch);
};

const meta = {
  title: "AI/RosterChangeCard",
  component: RosterChangeCard,
  parameters: {
    nextjs: { appDirectory: true, navigation: { pathname: "/roster" } },
  },
  decorators: [
    (Story) => (
      <div className="w-[420px]">
        <Story />
      </div>
    ),
  ],
  beforeEach: [withAssistant(), withFetchRoutes([])],
  args: { onSend: fn(), disabled: false },
} satisfies Meta<typeof RosterChangeCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Offered: Story = {
  beforeEach: show(CHANGE),
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("roster-change-summary")).toHaveTextContent(
      "Priya needs that night off.",
    );
    await expect(canvas.getAllByRole("row")).toHaveLength(3);
    await expect(canvas.getByTestId("roster-change-apply")).toBeEnabled();
  },
};

export const Revise: Story = {
  beforeEach: show(CHANGE),
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.type(canvas.getByLabelText("Tell me what to change"), "Try SN-Eve instead");
    await userEvent.click(canvas.getByRole("button", { name: "Send what to change" }));
    await expect(args.onSend).toHaveBeenCalledWith("Try SN-Eve instead");
    await expect(useAssistantStore.getState().activeRosterChange).toBeNull();
  },
};

export const NotChecked: Story = {
  beforeEach: show({
    ...CHANGE,
    view: { ...CHANGE.view, notChecked: ["Weekend rest for SN-Cara"] },
  }),
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("roster-change-not-checked")).toHaveTextContent(
      "Weekend rest for SN-Cara",
    );
  },
};

export const Leave: Story = {
  beforeEach: show({
    ...CHANGE,
    view: { ...CHANGE.view, leaveRows: ["SN-Asha takes leave on 11 Oct instead."] },
  }),
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("roster-change-leave")).toHaveTextContent(
      "SN-Asha takes leave on 11 Oct instead.",
    );
  },
};

// A linked change needs its named agreement ticked before Apply opens.
export const Agreement: Story = {
  beforeEach: show({
    ...CHANGE,
    view: {
      ...CHANGE.view,
      agreement: "SN-Asha agreed to come in on 8 Oct and take leave on 11 Oct instead.",
    },
  }),
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("roster-change-agree")).not.toBeChecked();
    await expect(canvas.getByTestId("roster-change-apply")).toBeDisabled();
  },
};

// The last Apply that did not finish is kept in the store and outlasts the card.
export const Failed: Story = {
  beforeEach: [
    show(CHANGE),
    () =>
      assistantActions.setRosterChangeNotice(
        "Nothing was changed: the Roster screen refused the change.",
      ),
  ],
  play: async ({ canvas, userEvent }) => {
    await expect(canvas.getByTestId("roster-change-failed")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Dismiss" }));
    await expect(canvas.queryByTestId("roster-change-failed")).toBeNull();
  },
};

export const Stopped: Story = {
  beforeEach: () => {
    assistantActions.showRosterChange(CHANGE, useAssistantStore.getState().turnEpoch - 1);
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("assistant-roster-change")).toHaveAttribute(
      "data-status",
      "stopped",
    );
    await expect(canvas.queryByTestId("roster-change-apply")).toBeNull();
  },
};

export const Dark: Story = {
  beforeEach: show(CHANGE),
  globals: { theme: "dark" },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("assistant-roster-change")).toBeVisible();
    await expect(document.body.textContent).not.toContain(SENTINEL_KEY);
  },
};
