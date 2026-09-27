import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, waitFor, within } from "storybook/test";
import { cardEditorDraftId } from "@/components/card-editor/card-editor-shell";
import { useNavGuardStore } from "@/components/shell/nav-guard-store";
import type { CountCard } from "@/lib/scenario";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import {
  drainScenarioCommands,
  pickScenario,
  scenarioCommands,
  useScenarioStore,
} from "@/lib/store";
import type { ScenarioSeed } from "../../.storybook/harness";
import { CountsEditor } from "./counts-editor";
import { buildCountCard, buildCountShiftTypeDomain, withCardDisabled } from "./counts-model";

// Zero-prop editor: the counts slice comes from a seeded scenario, and every play
// drives the real command bus and reads the store back.

const DOMAIN = buildCountShiftTypeDomain(makeValidUiState());

const AVERAGE = buildCountCard(
  {
    description: "Working shifts close to the average",
    person: ["Alice"],
    countDates: ["ALL"],
    countShiftTypes: ["N"],
    countShiftTypeCoefficients: [["N", 2]],
    expression: "x >= T",
    target: 5,
    weight: -1,
  },
  DOMAIN,
  "n1",
);

const NIGHT_CAP = withCardDisabled(
  buildCountCard(
    {
      description: "At most four nights",
      person: ["Bob"],
      countDates: ["ALL"],
      countShiftTypes: ["N"],
      countShiftTypeCoefficients: [["N", 1]],
      expression: "x <= T",
      target: 4,
      weight: -1,
    },
    DOMAIN,
    "n2",
  ),
  true,
);

const EMPTY_MESSAGE =
  "No shift counts defined yet. Add a Shift Count or Contracted Hours rule to get started.";
const ADD_LABEL = "Add Shift Count";

const withCards =
  (counts: CountCard[]): ScenarioSeed =>
  async () => {
    await scenarioCommands.mutate(pickScenario(makeValidUiState()));
    await scenarioCommands.mutate((s) => ({ cardsByKind: { ...s.cardsByKind, counts } }));
  };

/** One enabled card, one disabled, on the valid fixture's people and shifts. */
const POPULATED = withCards([AVERAGE, NIGHT_CAP]);

const meta = {
  title: "Counts/CountsEditor",
  component: CountsEditor,
  parameters: { scenario: POPULATED, layout: "padded" },
} satisfies Meta<typeof CountsEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

const cards = () => useScenarioStore.getState().cardsByKind.counts;

export const Populated: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("card-list-count")).toHaveTextContent("2 RULES");
    await expect(canvas.getByText(AVERAGE.description!)).toBeVisible();
    await expect(canvas.getByText(NIGHT_CAP.description!)).toBeVisible();
    await expect(within(canvas.getByTestId("count-card-1")).getByText("Disabled")).toBeVisible();
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
    await expect(useNavGuardStore.getState().drafts.has(cardEditorDraftId("counts"))).toBe(true);
    await userEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(canvas.queryByTestId("card-editor-form")).toBeNull());
    await waitFor(() =>
      expect(useNavGuardStore.getState().drafts.has(cardEditorDraftId("counts"))).toBe(false),
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
    await userEvent.click(canvas.getByTestId("count-dup-0"));
    await drainScenarioCommands();
    await expect(cards()).toHaveLength(3);
    await waitFor(() => expect(canvas.getByTestId("card-list-count")).toHaveTextContent("3 RULES"));
  },
};

export const Delete: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("count-delete-0"));
    await drainScenarioCommands();
    await expect(cards().map((card) => card.uid)).toEqual([NIGHT_CAP.uid]);
  },
};

export const Disable: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("count-disable-0"));
    await drainScenarioCommands();
    await expect(cards()[0]!.disabled).toBe(true);
  },
};

export const EditOpen: Story = {
  play: async ({ canvas, userEvent }) => {
    const before = cards();
    await userEvent.click(canvas.getByTestId("count-edit-0"));
    const form = await canvas.findByTestId("card-editor-form");
    await expect(within(form).getByDisplayValue(AVERAGE.description!)).toBeVisible();
    await userEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(canvas.queryByTestId("card-editor-form")).toBeNull());
    await drainScenarioCommands();
    await expect(cards()).toEqual(before);
  },
};

// The contracted-hours sub-form is opened, not filled (a 41 KB form: Phase 5 depth).
export const ContractedTab: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("add-contracted-toggle"));
    const form = await canvas.findByTestId("card-editor-form");
    await expect(within(form).getByText("Add Contracted Hours")).toBeVisible();
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
