import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, waitFor, within } from "storybook/test";
import { cardEditorDraftId } from "@/components/card-editor/card-editor-shell";
import { useNavGuardStore } from "@/components/shell/nav-guard-store";
import type { RequirementCard } from "@/lib/scenario";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import {
  drainScenarioCommands,
  pickScenario,
  scenarioCommands,
  useScenarioStore,
} from "@/lib/store";
import type { ScenarioSeed } from "../../.storybook/harness";
import { RequirementsEditor } from "./requirements-editor";
import { computeCoverageWarnings } from "./requirements-model";

// Zero-prop editor: the requirements slice comes from a seeded scenario, and every play
// drives the real command bus and reads the store back.

// Same shape as the valid fixture's own requirement card, on its shift ids.
const DAY_TWO: RequirementCard = {
  uid: "r1",
  description: "Two on every day shift",
  shiftType: "D",
  requiredNumPeople: 2,
  qualifiedPeople: "ALL",
  date: "ALL",
  weight: -1,
};

const NIGHT_ONE: RequirementCard = {
  uid: "r2",
  description: "One on every night",
  shiftType: "N",
  requiredNumPeople: 1,
  qualifiedPeople: "ALL",
  date: "ALL",
  weight: -1,
  disabled: true,
};

const EMPTY_MESSAGE = 'No requirements defined yet. Click "Add Requirement" to get started.';
const ADD_LABEL = "Add Requirement";

const withCards =
  (requirements: RequirementCard[]): ScenarioSeed =>
  async () => {
    await scenarioCommands.mutate(pickScenario(makeValidUiState()));
    await scenarioCommands.mutate((s) => ({ cardsByKind: { ...s.cardsByKind, requirements } }));
  };

/** One enabled card, one disabled, on the valid fixture's people and shifts. */
const POPULATED = withCards([DAY_TWO, NIGHT_ONE]);

const meta = {
  title: "Requirements/RequirementsEditor",
  component: RequirementsEditor,
  parameters: { scenario: POPULATED, layout: "padded" },
} satisfies Meta<typeof RequirementsEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

const cards = () => useScenarioStore.getState().cardsByKind.requirements;

export const Populated: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("card-list-count")).toHaveTextContent("2 RULES");
    await expect(canvas.getByText(DAY_TWO.description!)).toBeVisible();
    await expect(canvas.getByText(NIGHT_ONE.description!)).toBeVisible();
    await expect(
      within(canvas.getByTestId("requirement-card-1")).getByText("Disabled"),
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
    await expect(useNavGuardStore.getState().drafts.has(cardEditorDraftId("requirements"))).toBe(
      true,
    );
    await userEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(canvas.queryByTestId("card-editor-form")).toBeNull());
    await waitFor(() =>
      expect(useNavGuardStore.getState().drafts.has(cardEditorDraftId("requirements"))).toBe(false),
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
    await userEvent.click(canvas.getByTestId("requirement-dup-0"));
    await drainScenarioCommands();
    await expect(cards()).toHaveLength(3);
    await waitFor(() => expect(canvas.getByTestId("card-list-count")).toHaveTextContent("3 RULES"));
  },
};

export const Delete: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("requirement-delete-0"));
    await drainScenarioCommands();
    await expect(cards().map((card) => card.uid)).toEqual([NIGHT_ONE.uid]);
  },
};

export const Disable: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("requirement-disable-0"));
    await drainScenarioCommands();
    await expect(cards()[0]!.disabled).toBe(true);
  },
};

export const EditOpen: Story = {
  play: async ({ canvas, userEvent }) => {
    const before = cards();
    await userEvent.click(canvas.getByTestId("requirement-edit-0"));
    const form = await canvas.findByTestId("card-editor-form");
    await expect(within(form).getByDisplayValue(DAY_TWO.description!)).toBeVisible();
    await userEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(canvas.queryByTestId("card-editor-form")).toBeNull());
    await drainScenarioCommands();
    await expect(cards()).toEqual(before);
  },
};

export const CoverageDuplicate: Story = {
  parameters: { scenario: withCards([DAY_TWO, { ...DAY_TWO, uid: "r3" }]) },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("requirement-coverage-duplicate")).toBeVisible();
  },
};

export const CoverageUndefined: Story = {
  parameters: { scenario: withCards([DAY_TWO]) },
  play: async ({ canvas }) => {
    const state = useScenarioStore.getState();
    // Evening and Night are uncovered: the expectation comes from the same pure function.
    await expect(computeCoverageWarnings(state, cards()).undefinedSection).not.toBeNull();
    await expect(canvas.getByTestId("requirement-coverage-undefined")).toBeVisible();
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
