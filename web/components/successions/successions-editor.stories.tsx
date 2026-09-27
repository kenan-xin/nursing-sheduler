import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, waitFor, within } from "storybook/test";
import { cardEditorDraftId } from "@/components/card-editor/card-editor-shell";
import { useNavGuardStore } from "@/components/shell/nav-guard-store";
import type { SuccessionCard } from "@/lib/scenario";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import {
  drainScenarioCommands,
  pickScenario,
  scenarioCommands,
  useScenarioStore,
} from "@/lib/store";
import type { ScenarioSeed } from "../../.storybook/harness";
import { SuccessionsEditor } from "./successions-editor";
import { buildSuccessionCard, emptySuccessionForm } from "./successions-model";

// Zero-prop editor: the successions slice comes from a seeded scenario, and every play
// drives the real command bus and reads the store back.

const EVENING_DAY = buildSuccessionCard(
  {
    ...emptySuccessionForm(),
    description: "No Evening → Day",
    person: ["Alice"],
    pattern: ["E", "D"],
    weight: -5,
  },
  "s1",
);

const NIGHT_EVENING: SuccessionCard = {
  ...buildSuccessionCard(
    {
      ...emptySuccessionForm(),
      description: "Night then Evening",
      person: ["Bob"],
      pattern: ["N", "E"],
      weight: 3,
    },
    "s2",
  ),
  disabled: true,
};

const EMPTY_MESSAGE = 'No successions defined yet. Click "Add Succession" to get started.';
const ADD_LABEL = "Add Succession";

const withCards =
  (successions: SuccessionCard[]): ScenarioSeed =>
  async () => {
    await scenarioCommands.mutate(pickScenario(makeValidUiState()));
    await scenarioCommands.mutate((s) => ({ cardsByKind: { ...s.cardsByKind, successions } }));
  };

/** One enabled card, one disabled, on the valid fixture's people and shifts. */
const POPULATED = withCards([EVENING_DAY, NIGHT_EVENING]);

const meta = {
  title: "Successions/SuccessionsEditor",
  component: SuccessionsEditor,
  parameters: { scenario: POPULATED, layout: "padded" },
} satisfies Meta<typeof SuccessionsEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

const cards = () => useScenarioStore.getState().cardsByKind.successions;

export const Populated: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("card-list-count")).toHaveTextContent("2 RULES");
    await expect(canvas.getByText(EVENING_DAY.description!)).toBeVisible();
    await expect(canvas.getByText(NIGHT_EVENING.description!)).toBeVisible();
    await expect(
      within(canvas.getByTestId("succession-card-1")).getByText("Disabled"),
    ).toBeVisible();
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
    await expect(useNavGuardStore.getState().drafts.has(cardEditorDraftId("successions"))).toBe(
      true,
    );
    await userEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(canvas.queryByTestId("card-editor-form")).toBeNull());
    await waitFor(() =>
      expect(useNavGuardStore.getState().drafts.has(cardEditorDraftId("successions"))).toBe(false),
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
    await userEvent.click(canvas.getByTestId("succession-dup-0"));
    await drainScenarioCommands();
    await expect(cards()).toHaveLength(3);
    await waitFor(() => expect(canvas.getByTestId("card-list-count")).toHaveTextContent("3 RULES"));
  },
};

export const Delete: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("succession-delete-0"));
    await drainScenarioCommands();
    await expect(cards().map((card) => card.uid)).toEqual([NIGHT_EVENING.uid]);
  },
};

export const Disable: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("succession-disable-0"));
    await drainScenarioCommands();
    await expect(cards()[0]!.disabled).toBe(true);
  },
};

export const EditOpen: Story = {
  play: async ({ canvas, userEvent }) => {
    const before = cards();
    await userEvent.click(canvas.getByTestId("succession-edit-0"));
    const form = await canvas.findByTestId("card-editor-form");
    await expect(within(form).getByDisplayValue(EVENING_DAY.description!)).toBeVisible();
    await userEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(canvas.queryByTestId("card-editor-form")).toBeNull());
    await drainScenarioCommands();
    await expect(cards()).toEqual(before);
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
