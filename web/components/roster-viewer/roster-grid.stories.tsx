import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn } from "storybook/test";
import { deriveCurrentDays, type RosterDocument } from "@/lib/roster";
import {
  FIXTURE_REVERSE_MAP,
  fixtureCover,
  fixtureRosterDocument,
} from "@/lib/roster/test-fixtures";
import {
  assignShiftRamp,
  buildAssignmentIndex,
  computeCoverage,
  computeTallies,
  coverBandRows,
  deriveRequirementModel,
} from "@/lib/roster-viewer";
import { LONG_TOKEN, expectNoHorizontalOverflow } from "../../.storybook/story-helpers";
import { RosterContentWidthProvider } from "./roster-content-width";
import { RosterGrid, type RosterGridEditing } from "./roster-grid";

// Props derived from a real roster document with the same lib calls RosterViewer makes.
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
    tallies: computeTallies(context, currentDays),
    coverRows: coverBandRows(document.cover.entries, [], context.calendar),
  };
}

const meta = {
  title: "RosterViewer/RosterGrid",
  parameters: { layout: "padded", frameWidth: 960 },
  // The viewer mounts the grid under its content-width authority; so does the story.
  decorators: [
    (Story, { parameters }) => (
      <div data-testid="frame" style={{ width: parameters.frameWidth as number }}>
        <RosterContentWidthProvider>
          <Story />
        </RosterContentWidthProvider>
      </div>
    ),
  ],
  loaders: [async () => ({ document: await fixtureRosterDocument() })],
  args: {},
  render: ({ editing }, { loaded }) => (
    <RosterGrid {...derive(loaded.document as RosterDocument)} editing={editing} />
  ),
} satisfies Meta<{ editing?: RosterGridEditing }>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ReadOnly: Story = {
  play: async ({ canvas }) => {
    const grid = canvas.getByTestId("roster-grid");
    await expect(grid).toHaveTextContent("Alice Ng");
    await expect(grid.querySelector('[role="button"]')).toBeNull();
  },
};

export const Editing: Story = {
  args: { editing: { selectedCell: null, onSelectCell: fn(), onSwapCells: fn() } },
  play: async ({ args, canvas, userEvent }) => {
    const cells = canvas.getAllByRole("button", { name: /^Alice Ng / });
    await userEvent.click(cells[2]!);
    await expect(args.editing!.onSelectCell).toHaveBeenCalledOnce();
    await expect(args.editing!.onSelectCell).toHaveBeenCalledWith({ personIdx: 0, dateIdx: 2 });
  },
};

export const CoverBand: Story = {
  loaders: [async () => ({ document: await fixtureRosterDocument({ cover: fixtureCover() }) })],
  play: async ({ canvas }) => {
    await expect(canvas.getAllByTestId("roster-cover-band-row")).toHaveLength(
      fixtureCover().entries.length,
    );
  },
};

// Below the 900px wrap threshold the legend folds into a disclosure.
export const Legend: Story = {
  parameters: { frameWidth: 600 },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("roster-grid-legend-summary"));
    await expect(canvas.getByTestId("roster-grid-legend-disclosure")).toHaveAttribute("open");
    await expect(canvas.getByTestId("roster-grid-legend")).toBeVisible();
  },
};

// A long name widens the grid, which scrolls inside itself; the frame never overflows.
export const LongText: Story = {
  // a11y violation tracked in nursing-sheduler-w0e.30; restore "error" when fixed
  parameters: { a11y: { test: "todo" } },
  loaders: [
    async () => ({
      document: await fixtureRosterDocument({
        reverseMap: [["P1", LONG_TOKEN], FIXTURE_REVERSE_MAP[1]!],
      }),
    }),
  ],
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("roster-grid")).toHaveTextContent(LONG_TOKEN);
    await expectNoHorizontalOverflow(canvas.getByTestId("frame"));
  },
};

export const Dark: Story = {
  loaders: [async () => ({ document: await fixtureRosterDocument({ cover: fixtureCover() }) })],
  globals: { theme: "dark" },
};
