import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { getRouter } from "@storybook/nextjs-vite/navigation.mock";
import { expect, fn, within } from "storybook/test";
import type { RequirementCard } from "@/lib/scenario";
import { makeTemporaryCover, makeValidUiState } from "@/lib/scenario/test-fixtures";
import { pickScenario, scenarioCommands, useScenarioStore } from "@/lib/store";
import type { ScenarioSeed } from "../../.storybook/harness";
import {
  LONG_PROSE,
  LONG_TOKEN,
  expectNoHorizontalOverflow,
  withNarrowFrame,
} from "../../.storybook/story-helpers";
import { RequirementCardList } from "./requirement-card-list";

// The list takes its cards as a prop but reads the scenario's cover slices itself, so
// the cards are seeded into the store and read back in `render`: both come from one
// scenario, as on the Requirements screen.
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

const withRequirements = (
  requirements: RequirementCard[],
  extra: Parameters<typeof scenarioCommands.mutate>[0] = {},
) =>
  (async () => {
    await scenarioCommands.mutate(pickScenario(makeValidUiState()));
    await scenarioCommands.mutate((s) => ({ cardsByKind: { ...s.cardsByKind, requirements } }));
    await scenarioCommands.mutate(extra);
  }) satisfies ScenarioSeed;

function SeededList(props: Omit<Parameters<typeof RequirementCardList>[0], "requirements">) {
  const requirements = useScenarioStore((s) => s.cardsByKind.requirements);
  return <RequirementCardList {...props} requirements={requirements} />;
}

const meta = {
  title: "Requirements/RequirementCardList",
  component: RequirementCardList,
  parameters: {
    scenario: withRequirements([DAY_TWO, NIGHT_ONE]),
    layout: "padded",
    nextjs: { appDirectory: true, navigation: { pathname: "/shift-type-requirements" } },
  },
  args: {
    requirements: [],
    onEdit: fn(),
    onDuplicate: fn(),
    onDelete: fn(),
    onSetDisabled: fn(),
    onReorder: fn(),
  },
  render: ({ requirements: _ignored, ...handlers }) => <SeededList {...handlers} />,
} satisfies Meta<typeof RequirementCardList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("requirement-edit-0"));
    await expect(args.onEdit).toHaveBeenCalledWith("r1");
    await userEvent.click(canvas.getByTestId("requirement-dup-0"));
    await expect(args.onDuplicate).toHaveBeenCalledWith("r1");
    await userEvent.click(canvas.getByTestId("requirement-delete-0"));
    await expect(args.onDelete).toHaveBeenCalledWith("r1");
    // Card 1 is disabled, so its toggle asks for `false`.
    await userEvent.click(canvas.getByTestId("requirement-disable-1"));
    await expect(args.onSetDisabled).toHaveBeenCalledWith("r2", false);
  },
};

export const WithCover: Story = {
  parameters: {
    scenario: withRequirements([DAY_TWO], {
      temporaryCover: [makeTemporaryCover({ shiftType: "D", date: "2026-05-15" })],
    }),
  },
  play: async ({ canvas, userEvent }) => {
    const exceptions = canvas.getByTestId("requirement-exceptions-r1");
    await expect(exceptions).toHaveTextContent("Haseena (Ward 3) covering");
    await userEvent.click(within(exceptions).getByRole("link", { name: /Staff/ }));
    await expect(getRouter().push).toHaveBeenCalledWith("/people");
  },
};

export const Empty: Story = {
  parameters: { scenario: withRequirements([]) },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("requirements-list").children).toHaveLength(0);
  },
};

export const LongText: Story = {
  parameters: {
    scenario: withRequirements([{ ...DAY_TWO, description: LONG_PROSE, shiftType: LONG_TOKEN }]),
  },
  decorators: [withNarrowFrame],
  play: async ({ canvas }) => {
    await expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"));
    await expect(canvas.getByTitle(LONG_TOKEN)).toBeVisible();
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
