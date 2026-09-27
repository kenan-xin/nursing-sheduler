import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, within } from "storybook/test";
import { prepareWorkspaceExport, type ScenarioUiState } from "@/lib/scenario";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import { pickScenario } from "@/lib/store";
import type { ScenarioSeed } from "../../.storybook/harness";
import { LONG_TOKEN, expectNoHorizontalOverflow } from "../../.storybook/story-helpers";
import { ScenarioYamlPreview } from "./scenario-yaml-preview";

// Presentational apart from the PersistenceBadge, which reads the store: the scenario
// is installed so the badge shows the real post-bring-up `Saved`.
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
const EXPORT = prepareWorkspaceExport(VALID_STATE);
const CORRUPT_EXPORT = prepareWorkspaceExport(makeDuplicateIdUiState());
const ISSUES = CORRUPT_EXPORT.ok ? [] : CORRUPT_EXPORT.issues;

const meta = {
  title: "SaveLoad/ScenarioYamlPreview",
  component: ScenarioYamlPreview,
  parameters: { scenario: VALID, layout: "padded" },
  args: {
    exportResult: EXPORT,
    schema: VALID_STATE.meta.apiVersion,
    editing: false,
    draft: "",
    issues: null,
    onDraftChange: fn(),
    onApply: fn(),
    onCancel: fn(),
  },
} satisfies Meta<typeof ScenarioYamlPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Preview: Story = {
  play: async ({ canvas }) => {
    await expect(EXPORT.ok).toBe(true);
    await expect(canvas.getByTestId("scenario-yaml-content").textContent).toBe(
      EXPORT.ok ? EXPORT.yaml : "",
    );
    await expect(canvas.getByTestId("persistence-badge")).toHaveTextContent("Saved");
    await expect(canvas.getByTestId("scenario-version-footer")).toHaveTextContent(
      `SCHEMA ${VALID_STATE.meta.apiVersion}`,
    );
  },
};

export const Invalid: Story = {
  args: { exportResult: CORRUPT_EXPORT },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("scenario-export-issues")).toBeVisible();
    await expect(canvas.queryByTestId("scenario-yaml-content")).toBeNull();
  },
};

export const Editing: Story = {
  args: { editing: true, draft: "meta:\n" },
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByRole("heading", { name: "Edit YAML Configuration" })).toBeVisible();
    await userEvent.type(canvas.getByTestId("scenario-yaml-textarea"), "x");
    await expect(args.onDraftChange).toHaveBeenCalled();
    await userEvent.click(canvas.getByTestId("yaml-apply-button"));
    await expect(args.onApply).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByTestId("yaml-cancel-button"));
    await expect(args.onCancel).toHaveBeenCalledOnce();
    await expect(canvas.queryByTestId("persistence-badge")).toBeNull();
  },
};

export const EditingWithIssues: Story = {
  args: { editing: true, draft: "meta:\n", issues: ISSUES },
  play: async ({ canvas }) => {
    await expect(
      within(canvas.getByTestId("scenario-yaml-editor")).getByTestId("scenario-export-issues"),
    ).toBeVisible();
  },
};

export const LongText: Story = {
  args: {
    exportResult: { ok: true, yaml: `meta:\n  description: ${LONG_TOKEN}${LONG_TOKEN}\n` },
  },
  decorators: [
    (Story) => (
      <div className="w-[480px]">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvas }) => {
    // The <pre> scrolls itself; the card must not.
    await expectNoHorizontalOverflow(canvas.getByTestId("scenario-yaml-preview"));
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
