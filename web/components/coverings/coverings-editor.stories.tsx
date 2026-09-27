import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, waitFor, within } from "storybook/test";
import { cardEditorDraftId } from "@/components/card-editor/card-editor-shell";
import { useNavGuardStore } from "@/components/shell/nav-guard-store";
import type { CoveringCard } from "@/lib/scenario";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import {
  drainScenarioCommands,
  pickScenario,
  scenarioCommands,
  useScenarioStore,
} from "@/lib/store";
import type { ScenarioSeed } from "../../.storybook/harness";
import { CoveringsEditor } from "./coverings-editor";
import { buildCoveringCard, emptyCoveringForm, withCardDisabled } from "./coverings-model";

// Zero-prop editor: the coverings slice comes from a seeded scenario, and every play
// drives the real command bus and reads the store back.

const MENTOR = buildCoveringCard(
  {
    ...emptyCoveringForm(),
    description: "Every new starter on days is supervised",
    preceptors: ["Alice"],
    preceptees: ["Bob"],
    shiftTypes: ["D"],
    dates: ["WEEKDAY"],
  },
  "c1",
);

const NIGHTS = withCardDisabled(
  buildCoveringCard(
    {
      ...emptyCoveringForm(),
      description: "Night shift pairings",
      preceptors: ["Bob"],
      preceptees: ["Alice"],
      shiftTypes: ["N"],
      dates: [],
    },
    "c2",
  ),
  true,
);

const EMPTY_MESSAGE = 'No covering rules yet. Click "Add Shift Type Covering" to get started.';
const ADD_LABEL = "Add Shift Type Covering";

const withCards =
  (coverings: CoveringCard[]): ScenarioSeed =>
  async () => {
    await scenarioCommands.mutate(pickScenario(makeValidUiState()));
    await scenarioCommands.mutate((s) => ({ cardsByKind: { ...s.cardsByKind, coverings } }));
  };

/** One enabled card, one disabled, on the valid fixture's people and shifts. */
const POPULATED = withCards([MENTOR, NIGHTS]);

const meta = {
  title: "Coverings/CoveringsEditor",
  component: CoveringsEditor,
  parameters: { scenario: POPULATED, layout: "padded" },
} satisfies Meta<typeof CoveringsEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

const cards = () => useScenarioStore.getState().cardsByKind.coverings;

export const Populated: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("card-list-count")).toHaveTextContent("2 RULES");
    await expect(canvas.getByText(MENTOR.description!)).toBeVisible();
    await expect(canvas.getByText(NIGHTS.description!)).toBeVisible();
    await expect(within(canvas.getByTestId("covering-card-1")).getByText("Disabled")).toBeVisible();
  },
};

export const Empty: Story = {
  parameters: { scenario: withCards([]) },
  play: async ({ canvas, userEvent }) => {
    const empty = canvas.getByTestId("card-editor-empty");
    await expect(empty).toHaveTextContent(EMPTY_MESSAGE);
    await userEvent.click(within(empty).getByRole("button", { name: ADD_LABEL }));
    await expect(await canvas.findByTestId("card-editor-form")).toBeVisible();
  },
};

export const AddOpenCancel: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("add-card-toggle"));
    const form = await canvas.findByTestId("card-editor-form");
    await expect(form).toBeVisible();
    await expect(useNavGuardStore.getState().drafts.has(cardEditorDraftId("coverings"))).toBe(true);
    await userEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(canvas.queryByTestId("card-editor-form")).toBeNull());
    await waitFor(() =>
      expect(useNavGuardStore.getState().drafts.has(cardEditorDraftId("coverings"))).toBe(false),
    );
  },
};

export const AddInvalid: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("add-card-toggle"));
    await userEvent.click(await canvas.findByTestId("card-editor-submit"));
    const errors = await within(canvas.getByTestId("card-editor-form")).findAllByRole("alert");
    await expect(errors.length).toBeGreaterThan(0);
    await drainScenarioCommands();
    await expect(cards()).toHaveLength(2);
  },
};

export const Duplicate: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("covering-dup-0"));
    await drainScenarioCommands();
    await expect(cards()).toHaveLength(3);
    await waitFor(() => expect(canvas.getByTestId("card-list-count")).toHaveTextContent("3 RULES"));
  },
};

export const Delete: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("covering-delete-0"));
    await drainScenarioCommands();
    await expect(cards().map((card) => card.uid)).toEqual([NIGHTS.uid]);
  },
};

export const Disable: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("covering-disable-0"));
    await drainScenarioCommands();
    await expect(cards()[0]!.disabled).toBe(true);
  },
};

export const EditOpen: Story = {
  play: async ({ canvas, userEvent }) => {
    const before = cards();
    await userEvent.click(canvas.getByTestId("covering-edit-0"));
    const form = await canvas.findByTestId("card-editor-form");
    await expect(within(form).getByDisplayValue(MENTOR.description!)).toBeVisible();
    await userEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(canvas.queryByTestId("card-editor-form")).toBeNull());
    await drainScenarioCommands();
    await expect(cards()).toEqual(before);
  },
};

export const Help: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("card-editor-help-toggle"));
    await expect(await canvas.findByTestId("card-editor-instructions")).toHaveTextContent(
      /always enforced as a hard rule/i,
    );
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
