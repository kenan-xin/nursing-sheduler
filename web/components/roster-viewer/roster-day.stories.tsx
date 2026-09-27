import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, within } from "storybook/test";
import { deriveCurrentDays, type RosterDocument } from "@/lib/roster";
import {
  FIXTURE_DATES,
  FIXTURE_HOLIDAY,
  FIXTURE_REVERSE_MAP,
  fixtureRosterDocument,
} from "@/lib/roster/test-fixtures";
import {
  assignShiftRamp,
  buildAssignmentIndex,
  computeCoverage,
  computeRequirementGrid,
  deriveRequirementModel,
} from "@/lib/roster-viewer";
import { LONG_TOKEN, expectNoHorizontalOverflow } from "../../.storybook/story-helpers";
import { RosterDay } from "./roster-day";

// Props derived from a real roster document with the same lib calls RosterViewer makes.
// The fixture's day 3 (2026-07-05) leaves the one D requirement unstaffed.
function derive(document: RosterDocument) {
  const { context } = document;
  const currentDays = deriveCurrentDays(document.solvedDays, document.edits);
  const model = deriveRequirementModel(document.submission, {
    decrements: document.cover.decrements,
    live: [],
  });
  const assignments = buildAssignmentIndex(context, currentDays);
  return {
    context,
    currentDays,
    ramp: assignShiftRamp(context.shiftTypes),
    coverage: computeCoverage(context, assignments, model),
    model,
    requirements: computeRequirementGrid(model, assignments, context.calendar.length),
  };
}

const meta = {
  title: "RosterViewer/RosterDay",
  parameters: {
    layout: "padded",
    // a11y violation tracked in nursing-sheduler-w0e.29; restore "error" when fixed
    a11y: { test: "todo" },
  },
  loaders: [async () => ({ document: await fixtureRosterDocument() })],
  args: { focusedDay: 0, onFocusDay: fn() },
  render: (args, { loaded }) => (
    <RosterDay {...derive(loaded.document as RosterDocument)} {...args} />
  ),
} satisfies Meta<{ focusedDay: number; onFocusDay: (dateIdx: number) => void }>;

export default meta;
type Story = StoryObj<typeof meta>;

const tabs = (root: HTMLElement) => within(root).getAllByRole("tab");

export const Default: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getAllByTestId("roster-day-shift-panel").length).toBeGreaterThan(0);
    await expect(canvas.getAllByTestId("roster-day-person")[0]).toHaveAttribute(
      "data-person",
      "Alice Ng",
    );
    const strip = tabs(canvas.getByTestId("roster-day"));
    await expect(strip).toHaveLength(FIXTURE_DATES.length);
    await userEvent.click(strip[1]!);
    await expect(args.onFocusDay).toHaveBeenCalledOnce();
    await expect(args.onFocusDay).toHaveBeenCalledWith(1);
  },
};

export const Mismatch: Story = {
  args: { focusedDay: 2 },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("roster-day-mismatch")).toBeVisible();
  },
};

export const Holiday: Story = {
  args: { focusedDay: FIXTURE_DATES.indexOf(FIXTURE_HOLIDAY) },
  play: async ({ canvas }) => {
    const focused = tabs(canvas.getByTestId("roster-day"))[3]!;
    await expect(focused).toHaveAttribute("aria-selected", "true");
  },
};

export const LongText: Story = {
  loaders: [
    async () => ({
      document: await fixtureRosterDocument({
        reverseMap: [["P1", LONG_TOKEN], FIXTURE_REVERSE_MAP[1]!],
      }),
    }),
  ],
  decorators: [
    (Story) => (
      <div data-testid="frame" className="w-[480px]">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvas }) => {
    await expect(canvas.getAllByTestId("roster-day-person")[0]).toHaveAttribute(
      "data-person",
      LONG_TOKEN,
    );
    await expectNoHorizontalOverflow(canvas.getByTestId("frame"));
  },
};

export const Dark: Story = {
  args: { focusedDay: 2 },
  globals: { theme: "dark" },
};
