import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { getRouter } from "@storybook/nextjs-vite/navigation.mock";
import { expect, fn } from "storybook/test";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import {
  drainScenarioCommands,
  pickScenario,
  scenarioCommands,
  useScenarioStore,
} from "@/lib/store";
import type { ScenarioSeed } from "../../.storybook/harness";
import { RulesScreen } from "./rules-screen";

// Every row is derived from `cardsByKind`; each play writes through the row and reads
// the card back from the store.
const DAY_CAP: ScenarioSeed = async () => {
  await scenarioCommands.mutate(pickScenario(makeValidUiState()));
  await scenarioCommands.mutate((s) => ({
    cardsByKind: {
      ...s.cardsByKind,
      requirements: [
        { uid: "r1", shiftType: "D", requiredNumPeople: 2, weight: -1, description: "Day cap" },
      ],
    },
  }));
};

const ROW = "requirements:r1";
const card = () => useScenarioStore.getState().cardsByKind.requirements[0]!;

const meta = {
  title: "GuidedRules/RulesScreen",
  component: RulesScreen,
  parameters: {
    scenario: DAY_CAP,
    layout: "padded",
    nextjs: { appDirectory: true, navigation: { pathname: "/rules" } },
  },
  args: { onOpenAdvanced: fn() },
} satisfies Meta<typeof RulesScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  parameters: { scenario: "empty" },
  play: async ({ canvas }) => {
    await expect(canvas.getByText(/At most one shift per day/)).toBeVisible();
    await expect(canvas.getByTestId("rules-empty-state")).toBeVisible();
  },
};

export const Linked: Story = {
  play: async ({ canvas, userEvent }) => {
    await expect(canvas.getByText("Day cap")).toBeVisible();
    await userEvent.click(canvas.getByTestId(`rule-toggle-${ROW}`));
    await drainScenarioCommands();
    await expect(card().disabled).toBe(true);
  },
};

export const Adjust: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId(`rule-adjust-toggle-${ROW}`));
    const input = await canvas.findByTestId(`rule-adjust-input-${ROW}-requiredNumPeople`);
    await userEvent.clear(input);
    await userEvent.type(input, "5");
    // Typing alone must not write the store; the commit happens on blur.
    await drainScenarioCommands();
    await expect(card().requiredNumPeople).toBe(2);
    await userEvent.tab();
    await drainScenarioCommands();
    await expect(card().requiredNumPeople).toBe(5);
  },
};

export const Rename: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId(`rule-rename-${ROW}`));
    const input = await canvas.findByTestId(`rule-rename-input-${ROW}`);
    await userEvent.clear(input);
    await userEvent.type(input, "Weekend cap");
    await userEvent.click(canvas.getByTestId(`rule-rename-save-${ROW}`));
    await drainScenarioCommands();
    await expect(card().description).toBe("Weekend cap");
  },
};

export const FromAdvanced: Story = {
  args: { advancedSource: "shift-type-requirements" },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("rules-advanced-source")).toHaveTextContent(
      "You came from Staffing Requirements in Advanced. Its rules are under Staffing levels below.",
    );
  },
};

export const OpenAdvanced: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId(`rule-open-advanced-${ROW}`));
    await expect(args.onOpenAdvanced).toHaveBeenCalledWith("/shift-type-requirements");
  },
};

export const Continue: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("rules-continue"));
    await expect(getRouter().push).toHaveBeenCalledWith("/shift-requests");
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
