import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, screen, waitFor } from "storybook/test";
import type { AutosaveSnapshot, RosterDocument } from "@/lib/roster";
import { fixtureRosterDocument } from "@/lib/roster/test-fixtures";
import { EmptyRosterActions, RosterActions } from "./roster-actions";
import { RosterContentWidthProvider } from "./roster-content-width";

const SAVED: AutosaveSnapshot = { status: "saved", failure: null, dirty: false };

// The roster file the import control accepts is a `.nurse-roster.json`.
const rosterFile = () =>
  new File(['{"format":"nurse-roster"}'], "ward.nurse-roster.json", {
    type: "application/json",
  });

interface Args {
  save: AutosaveSnapshot;
  onRetrySave: () => void;
  onImportFile: (file: File) => void;
  onClear: () => void;
  onExportError: (message: string) => void;
}

const meta = {
  title: "RosterViewer/RosterActions",
  parameters: { layout: "padded", frameWidth: 1100 },
  // Wide vs stacked comes from the roster content-width authority the section provides.
  decorators: [
    (Story, { parameters }) => (
      <div style={{ width: parameters.frameWidth as number }}>
        <RosterContentWidthProvider>
          <Story />
        </RosterContentWidthProvider>
      </div>
    ),
  ],
  loaders: [async () => ({ document: await fixtureRosterDocument() })],
  args: {
    save: SAVED,
    onRetrySave: fn(),
    onImportFile: fn(),
    onClear: fn(),
    onExportError: fn(),
  },
  render: (args, { loaded }) => (
    <RosterActions {...args} document={loaded.document as RosterDocument} />
  ),
} satisfies Meta<Args>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Saved: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("roster-save-saved")).toBeVisible();
    await expect(canvas.getByTestId("roster-export-xlsx")).toBeVisible();
  },
};

export const Saving: Story = {
  args: { save: { status: "saving", failure: null, dirty: true } },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("roster-save-saving")).toBeVisible();
  },
};

export const SaveFailed: Story = {
  args: {
    save: {
      status: "failed",
      failure: { reason: "write-error", message: "Your edits could not be saved." },
      dirty: true,
    },
  },
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByTestId("roster-save-failed")).toBeVisible();
    await userEvent.click(canvas.getByTestId("roster-save-retry"));
    await expect(args.onRetrySave).toHaveBeenCalledOnce();
  },
};

export const Import: Story = {
  play: async ({ args, canvasElement, userEvent }) => {
    const input = canvasElement.querySelector<HTMLInputElement>('input[type="file"]')!;
    await userEvent.upload(input, rosterFile());
    await expect(args.onImportFile).toHaveBeenCalledOnce();
    await expect(args.onImportFile).toHaveBeenCalledWith(
      expect.objectContaining({ name: "ward.nurse-roster.json" }),
    );
  },
};

export const Clear: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("roster-clear"));
    await expect(args.onClear).toHaveBeenCalledOnce();
  },
};

// Narrow: Save / Import / Clear fold into one "Roster file" menu (portalled).
export const FileMenu: Story = {
  parameters: { frameWidth: 480 },
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("roster-file-menu"));
    const clear = await screen.findByTestId("roster-clear");
    await waitFor(() => expect(clear).toBeVisible());
    await userEvent.click(clear);
    await expect(args.onClear).toHaveBeenCalledOnce();
    // Let the menu finish closing (its focus guards go with it) before axe runs.
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  },
};

export const EmptyActions: Story = {
  render: (args) => <EmptyRosterActions onImportFile={args.onImportFile} onClear={args.onClear} />,
  play: async ({ args, canvas, userEvent }) => {
    const row = canvas.getByTestId("roster-empty-actions");
    await expect(row).toContainElement(canvas.getByTestId("roster-import"));
    await userEvent.click(canvas.getByTestId("roster-clear"));
    await expect(args.onClear).toHaveBeenCalledOnce();
  },
};

export const Dark: Story = {
  args: {
    save: {
      status: "failed",
      failure: { reason: "cas-conflict", message: "Another tab changed this roster." },
      dirty: true,
    },
  },
  globals: { theme: "dark" },
};
