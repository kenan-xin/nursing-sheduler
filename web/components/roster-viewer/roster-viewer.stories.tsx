import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, waitFor } from "storybook/test";
import type { RosterDocument } from "@/lib/roster";
import { fixtureRosterDocument, withEdits } from "@/lib/roster/test-fixtures";
import { ROSTER_VIEW_PREFERENCE_KEY } from "@/lib/roster-viewer";
import { RosterContentWidthProvider } from "./roster-content-width";
import { RosterViewer, type RosterViewerEditing } from "./roster-viewer";

// The viewer reads live temporary cover from the scenario store, so each story gets a
// fresh (empty) scenario; its lens preference lives in localStorage and is reset too.
const editing = (over: Partial<RosterViewerEditing> = {}): RosterViewerEditing => ({
  selectedCell: null,
  selectCell: fn(),
  setCell: fn(),
  swapCells: fn(),
  undo: fn(),
  canUndo: false,
  ...over,
});

const meta = {
  title: "RosterViewer/RosterViewer",
  parameters: { scenario: "empty", layout: "padded" },
  beforeEach: () => {
    localStorage.removeItem(ROSTER_VIEW_PREFERENCE_KEY);
    return () => localStorage.removeItem(ROSTER_VIEW_PREFERENCE_KEY);
  },
  decorators: [
    (Story) => (
      <div className="w-[1100px]">
        <RosterContentWidthProvider>
          <Story />
        </RosterContentWidthProvider>
      </div>
    ),
  ],
  loaders: [async () => ({ document: await fixtureRosterDocument() })],
  args: {},
  render: (args, { loaded }) => (
    <RosterViewer editing={args.editing} document={loaded.document as RosterDocument} />
  ),
} satisfies Meta<{ editing?: RosterViewerEditing }>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ReadOnly: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("roster-grid")).toHaveTextContent("Alice Ng");
    await expect(canvas.queryByTestId("roster-undo")).toBeNull();
    await expect(canvas.getByTestId("roster-lens-grid")).toHaveAttribute("aria-pressed", "true");
  },
};

// A selected cell opens the edit bar; OFF writes that day-state to the coordinate.
export const Editing: Story = {
  args: { editing: editing({ selectedCell: { personIdx: 0, dateIdx: 2 } }) },
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByTestId("roster-edit-bar")).toBeVisible();
    await userEvent.click(canvas.getByTestId("roster-edit-option-OFF"));
    await expect(args.editing!.setCell).toHaveBeenCalledOnce();
    await expect(args.editing!.setCell).toHaveBeenCalledWith(
      { personIdx: 0, dateIdx: 2 },
      { kind: "off" },
    );
    await userEvent.click(canvas.getByTestId("roster-edit-bar-cancel"));
    await expect(args.editing!.selectCell).toHaveBeenCalledWith(null);
  },
};

export const DayLens: Story = {
  // a11y violation tracked in nursing-sheduler-w0e.29; restore "error" when fixed
  parameters: { a11y: { test: "todo" } },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("roster-lens-day"));
    await waitFor(() => expect(canvas.getByTestId("roster-day")).toBeVisible());
    await expect(canvas.queryByTestId("roster-grid")).toBeNull();
  },
};

export const Undo: Story = {
  args: { editing: editing({ canUndo: true }) },
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("roster-undo"));
    await expect(args.editing!.undo).toHaveBeenCalledOnce();
  },
};

export const Provenance: Story = {
  loaders: [
    async () => ({
      document: withEdits(await fixtureRosterDocument(), [
        { personIdx: 0, dateIdx: 1, day: { kind: "shift", shiftId: "D" } },
      ]),
    }),
  ],
  play: async ({ canvas }) => {
    const provenance = canvas.getByTestId("roster-provenance");
    await expect(provenance).toHaveTextContent("edited since solve");
    await expect(canvas.getByTestId("roster-coverage-summary")).toBeVisible();
  },
};

export const Dark: Story = {
  args: { editing: editing({ canUndo: true }) },
  globals: { theme: "dark" },
};
