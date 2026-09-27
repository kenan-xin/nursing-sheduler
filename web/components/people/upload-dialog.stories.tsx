import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, screen, waitFor } from "storybook/test";
import { createEmptyScenarioUiState, type ScenarioUiState } from "@/lib/scenario";
import { withToaster } from "../../.storybook/harness";
import { peopleDescriptor } from "./people-descriptor";
import { UploadDialog } from "./upload-dialog";

// Portalled (Base UI Dialog): query with `screen`. Props as upload-dialog.test.tsx builds them.
const STATE: ScenarioUiState = {
  ...createEmptyScenarioUiState(),
  staff: [{ id: "Kevin Ong", history: [] }],
};

const meta = {
  title: "People/UploadDialog",
  component: UploadDialog,
  decorators: [withToaster],
  args: {
    descriptor: peopleDescriptor,
    commit: fn(),
    currentState: () => STATE,
    onClose: fn(),
  },
} satisfies Meta<typeof UploadDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

async function openDialog() {
  const dialog = await screen.findByTestId("upload-dialog");
  await waitFor(() => expect(dialog).toBeVisible());
  return dialog;
}

const txt = (content: string) => new File([content], "people.txt", { type: "text/plain" });

export const Open: Story = {
  play: async ({ args, userEvent }) => {
    const dialog = await openDialog();
    await expect(dialog).toHaveAccessibleName("Upload people list");
    // The one overlay that ignores Escape.
    await userEvent.keyboard("{Escape}");
    await expect(args.onClose).not.toHaveBeenCalled();
  },
};

export const Upload: Story = {
  play: async ({ args, userEvent }) => {
    await openDialog();
    await userEvent.upload(screen.getByTestId("upload-file-input"), txt("Aisha\nKevin Ong\n"));
    await waitFor(() => expect(args.commit).toHaveBeenCalledOnce());
    // `commit` receives the queue-head transform: applied to the live state it adds Aisha.
    const transform = (args.commit as ReturnType<typeof fn>).mock.calls[0]![0] as (
      s: ScenarioUiState,
    ) => ScenarioUiState | null;
    await expect(transform(STATE)?.staff.map((p) => p.id)).toEqual(["Aisha", "Kevin Ong"]);
    await expect(args.onClose).toHaveBeenCalledOnce();
  },
};

export const BadFile: Story = {
  play: async ({ args, userEvent }) => {
    await openDialog();
    await userEvent.upload(screen.getByTestId("upload-file-input"), txt("Aisha\nAisha\n"));
    const toast = await screen.findByText(/Duplicate person name "Aisha"/);
    await waitFor(() => expect(toast).toBeVisible());
    await expect(args.commit).not.toHaveBeenCalled();
    await expect(args.onClose).not.toHaveBeenCalled();
  },
};

export const Close: Story = {
  play: async ({ args, userEvent }) => {
    await openDialog();
    await userEvent.click(screen.getByTestId("upload-dialog-close"));
    await expect(args.onClose).toHaveBeenCalledOnce();
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
