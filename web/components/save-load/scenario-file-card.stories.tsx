import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, screen, spyOn, waitFor } from "storybook/test";
import { prepareWorkspaceExport, type ScenarioUiState } from "@/lib/scenario";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import {
  drainScenarioCommands,
  pickScenario,
  selectBackupStatus,
  useScenarioStore,
} from "@/lib/store";
import { withToaster, type ScenarioSeed } from "../../.storybook/harness";
import { ScenarioFileCard } from "./scenario-file-card";
import { SCENARIO_DOWNLOAD_FILENAME } from "./scenario-file-export";

// The card clicks a generated <a download>; a window bubble listener cancels the
// download after React has handled the click.
function blockDownloads(): () => void {
  const block = (event: MouseEvent) => {
    if (event.target instanceof HTMLAnchorElement && event.target.hasAttribute("download")) {
      event.preventDefault();
    }
  };
  window.addEventListener("click", block);
  return () => window.removeEventListener("click", block);
}

/** A structurally corrupt draft (two cards share a `uid`): the one thing export blocks. */
function makeDuplicateIdUiState(): ScenarioUiState {
  const state = makeValidUiState();
  state.cardsByKind.requirements = [
    { uid: "dup", shiftType: "D", requiredNumPeople: 1, weight: -1 },
    { uid: "dup", shiftType: "E", requiredNumPeople: 1, weight: -1 },
  ];
  return state;
}

const VALID_STATE = makeValidUiState();
const VALID: ScenarioSeed = pickScenario(VALID_STATE);
const CORRUPT_EXPORT = prepareWorkspaceExport(makeDuplicateIdUiState());

const meta = {
  title: "SaveLoad/ScenarioFileCard",
  component: ScenarioFileCard,
  parameters: { scenario: VALID, layout: "padded" },
  args: {
    scenario: VALID_STATE,
    canEditYaml: true,
    editing: false,
    importIssues: null,
    onUpload: fn(),
    onStartEdit: fn(),
  },
  decorators: [withToaster],
  beforeEach: blockDownloads,
} satisfies Meta<typeof ScenarioFileCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("heading", { name: "Scenario file" })).toBeVisible();
    await expect(canvas.getByTestId("scenario-edit-yaml-button")).toBeEnabled();
  },
};

export const Download: Story = {
  play: async ({ args, canvas, userEvent }) => {
    const before = selectBackupStatus(useScenarioStore.getState());
    await userEvent.click(canvas.getByTestId("scenario-download-button"));
    const toast = await screen.findByText(`Downloaded ${SCENARIO_DOWNLOAD_FILENAME}`);
    await waitFor(() => expect(toast).toBeVisible());
    // Recorded through the real `recordBackup` command.
    await drainScenarioCommands();
    await expect(selectBackupStatus(useScenarioStore.getState())).not.toBe(before);

    await userEvent.click(canvas.getByTestId("scenario-upload-button"));
    await expect(args.onUpload).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByTestId("scenario-edit-yaml-button"));
    await expect(args.onStartEdit).toHaveBeenCalledOnce();
  },
};

const spyOnClipboard = () => spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
let clipboard: ReturnType<typeof spyOnClipboard>;

export const Copy: Story = {
  beforeEach: () => {
    clipboard = spyOnClipboard();
    return () => clipboard.mockRestore();
  },
  play: async ({ canvas, userEvent }) => {
    const button = canvas.getByTestId("scenario-copy-button");
    await userEvent.click(button);
    await expect(clipboard).toHaveBeenCalledOnce();
    await expect(clipboard.mock.calls[0]![0]).toContain(
      `apiVersion: ${VALID_STATE.meta.apiVersion}`,
    );
    await waitFor(() => expect(button).toHaveTextContent("Copied!"));
  },
};

export const EditingLocked: Story = {
  args: { editing: true },
  play: async ({ args, canvas }) => {
    const edit = canvas.getByTestId("scenario-edit-yaml-button");
    await expect(edit).toBeDisabled();
    edit.click();
    await expect(args.onStartEdit).not.toHaveBeenCalled();
  },
};

export const ImportIssues: Story = {
  args: { importIssues: CORRUPT_EXPORT.ok ? null : CORRUPT_EXPORT.issues },
  play: async ({ canvas }) => {
    await expect(CORRUPT_EXPORT.ok).toBe(false);
    await expect(canvas.getByTestId("scenario-export-issues")).toBeVisible();
  },
};

export const InvalidScenario: Story = {
  args: { scenario: makeDuplicateIdUiState() },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("scenario-download-button"));
    await expect(await canvas.findByTestId("scenario-export-issues")).toBeVisible();
    await expect(screen.queryByText(/^Downloaded /)).toBeNull();
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
