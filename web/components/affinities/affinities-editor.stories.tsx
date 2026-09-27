import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, waitFor, within } from "storybook/test";
import { cardEditorDraftId } from "@/components/card-editor/card-editor-shell";
import { useNavGuardStore } from "@/components/shell/nav-guard-store";
import type { AffinityCard } from "@/lib/scenario";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import {
  drainScenarioCommands,
  pickScenario,
  scenarioCommands,
  useScenarioStore,
} from "@/lib/store";
import type { ScenarioSeed } from "../../.storybook/harness";
import { AffinitiesEditor } from "./affinities-editor";
import { buildAffinityCard, emptyAffinityForm, withCardDisabled } from "./affinities-model";

// Zero-prop editor: the affinities slice comes from a seeded scenario, and every play
// drives the real command bus and reads the store back.

const ENCOURAGE = buildAffinityCard(
  {
    ...emptyAffinityForm(),
    description: "Encourage newcomers and seniors to work together",
    people1: ["Alice"],
    people2: ["Bob"],
    shiftTypes: ["D"],
    date: ["ALL"],
    weight: 10,
  },
  "a1",
);

const DISABLED = withCardDisabled(
  buildAffinityCard(
    {
      ...emptyAffinityForm(),
      description: "Keep the night team together",
      people1: ["Bob"],
      people2: ["Alice"],
      shiftTypes: ["N"],
      date: ["WEEKEND"],
      weight: -5,
    },
    "a2",
  ),
  true,
);

// `buildAffinityCard` always emits ONE term, so a two-term (advanced) card is hand-built.
const ADVANCED: AffinityCard = {
  uid: "a4",
  description: "Advanced (multi-term) affinity",
  people1: [["Alice"], ["Bob"]],
  people2: ["Bob"],
  shiftTypes: ["D"],
  date: ["ALL"],
  weight: 5,
};

const EMPTY_MESSAGE = 'No affinities defined yet. Click "Add Affinity" to get started.';
const ADD_LABEL = "Add Affinity";

const withCards =
  (affinities: AffinityCard[]): ScenarioSeed =>
  async () => {
    await scenarioCommands.mutate(pickScenario(makeValidUiState()));
    await scenarioCommands.mutate((s) => ({ cardsByKind: { ...s.cardsByKind, affinities } }));
  };

/** One enabled card, one disabled, on the valid fixture's people and shifts. */
const POPULATED = withCards([ENCOURAGE, DISABLED]);

const meta = {
  title: "Affinities/AffinitiesEditor",
  component: AffinitiesEditor,
  parameters: { scenario: POPULATED, layout: "padded" },
} satisfies Meta<typeof AffinitiesEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

const cards = () => useScenarioStore.getState().cardsByKind.affinities;

export const Populated: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("card-list-count")).toHaveTextContent("2 RULES");
    await expect(canvas.getByText(ENCOURAGE.description!)).toBeVisible();
    await expect(canvas.getByText(DISABLED.description!)).toBeVisible();
    await expect(within(canvas.getByTestId("affinity-card-1")).getByText("Disabled")).toBeVisible();
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
    await expect(useNavGuardStore.getState().drafts.has(cardEditorDraftId("affinities"))).toBe(
      true,
    );
    await userEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(canvas.queryByTestId("card-editor-form")).toBeNull());
    await waitFor(() =>
      expect(useNavGuardStore.getState().drafts.has(cardEditorDraftId("affinities"))).toBe(false),
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
    await userEvent.click(canvas.getByTestId("affinity-dup-0"));
    await drainScenarioCommands();
    await expect(cards()).toHaveLength(3);
    await waitFor(() => expect(canvas.getByTestId("card-list-count")).toHaveTextContent("3 RULES"));
  },
};

export const Delete: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("affinity-delete-0"));
    await drainScenarioCommands();
    await expect(cards().map((card) => card.uid)).toEqual([DISABLED.uid]);
  },
};

export const Disable: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("affinity-disable-0"));
    await drainScenarioCommands();
    await expect(cards()[0]!.disabled).toBe(true);
  },
};

export const EditOpen: Story = {
  play: async ({ canvas, userEvent }) => {
    const before = cards();
    await userEvent.click(canvas.getByTestId("affinity-edit-0"));
    const form = await canvas.findByTestId("card-editor-form");
    await expect(within(form).getByDisplayValue(ENCOURAGE.description!)).toBeVisible();
    await userEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(canvas.queryByTestId("card-editor-form")).toBeNull());
    await drainScenarioCommands();
    await expect(cards()).toEqual(before);
  },
};

export const AdvancedCard: Story = {
  parameters: { scenario: withCards([ADVANCED]) },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("affinity-readonly-note-0")).toBeVisible();
    await expect(canvas.queryByTestId("affinity-edit-0")).toBeNull();
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
