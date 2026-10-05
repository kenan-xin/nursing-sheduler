import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import * as React from "react";
import { expect, screen, waitFor } from "storybook/test";
import { peopleDescriptor } from "@/components/people/people-descriptor";
import type { ScenarioUiState } from "@/lib/scenario";
import { drainScenarioCommands, scenarioCommands, useScenarioStore } from "@/lib/store";
import { withToaster, type ScenarioSeed } from "../../.storybook/harness";
import {
  LONG_TOKEN,
  expectNoHorizontalOverflow,
  withNarrowFrame,
} from "../../.storybook/story-helpers";
import { GroupsSection } from "./groups-section";

// The owner harness from groups-section.test.tsx: group-scoped selection plus the form-open
// token behind the stale-Save guard, committing through the real scenario command bus.
type GroupSel = null | { t: "add-group" } | { t: "edit-group"; id: string };

function GroupsHarness() {
  const descriptor = peopleDescriptor;
  const items = useScenarioStore(descriptor.readItems);
  const groups = useScenarioStore(descriptor.readGroups);
  const commit = React.useCallback(
    (transform: (live: ScenarioUiState) => ScenarioUiState | null) => {
      return scenarioCommands.mutate((live) => transform(live as ScenarioUiState));
    },
    [],
  );
  const [sel, setSel] = React.useState<GroupSel>(null);
  const editing = sel !== null;
  const openToken = React.useRef<{ items: typeof items; groups: typeof groups } | null>(null);
  const wasEditing = React.useRef(false);
  if (editing !== wasEditing.current) {
    wasEditing.current = editing;
    openToken.current = editing ? { items, groups } : null;
  }
  const isStale = React.useCallback(() => {
    const token = openToken.current;
    if (token === null) return false;
    const live = useScenarioStore.getState() as ScenarioUiState;
    return (
      descriptor.readItems(live) !== token.items || descriptor.readGroups(live) !== token.groups
    );
  }, [descriptor]);
  React.useEffect(() => {
    if (editing && isStale()) setSel(null);
  });
  return (
    <GroupsSection
      descriptor={descriptor}
      items={items}
      groups={groups}
      commit={commit}
      isStale={isStale}
      editing={editing}
      addOpen={sel?.t === "add-group"}
      editingGroupId={sel?.t === "edit-group" ? sel.id : null}
      onToggleAdd={() => setSel((cur) => (cur?.t === "add-group" ? null : { t: "add-group" }))}
      onEditGroup={(id) => setSel({ t: "edit-group", id })}
      onCloseForm={() => setSel(null)}
    />
  );
}

const STAFF = [
  { id: "Aisha", history: [] },
  { id: "Ben", history: [] },
  { id: "Chloe", history: [] },
];
const POPULATED: ScenarioSeed = {
  staff: STAFF,
  staffGroups: [
    { id: "Seniors", members: ["Aisha"] },
    { id: "Juniors", members: ["Ben", "Chloe"] },
  ],
};

const groupIds = async () => {
  await drainScenarioCommands();
  return useScenarioStore.getState().staffGroups.map((g) => g.id);
};

const meta = {
  title: "EntityEditor/GroupsSection",
  render: () => <GroupsHarness />,
  decorators: [withToaster],
  parameters: { layout: "padded", scenario: POPULATED },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  parameters: { scenario: { staff: STAFF, staffGroups: [] } },
  play: async ({ canvas, userEvent }) => {
    await expect(canvas.getByTestId("groups-empty")).toBeVisible();
    await userEvent.click(canvas.getByTestId("groups-empty-add"));
    await expect(await canvas.findByTestId("add-group-form")).toBeVisible();
  },
};

export const Populated: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("group-id-text-Seniors")).toBeVisible();
    await expect(canvas.getByTestId("group-id-text-Juniors")).toBeVisible();
  },
};

export const AddGroup: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("add-group-toggle"));
    await userEvent.type(canvas.getByTestId("add-group-id"), "Nights");
    await userEvent.click(canvas.getByRole("button", { name: "Add Chloe to group" }));
    await userEvent.click(canvas.getByTestId("group-save-__new__"));
    await drainScenarioCommands();
    const nights = useScenarioStore.getState().staffGroups.find((g) => g.id === "Nights");
    await expect(nights?.members).toEqual(["Chloe"]);
    const toast = await screen.findByText("Group “Nights” added.");
    await waitFor(() => expect(toast).toBeVisible());
  },
};

export const EditDuplicateDelete: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("group-edit-Seniors"));
    await expect(canvas.getByTestId("group-edit-form-Seniors")).toBeVisible();
    await userEvent.click(canvas.getByTestId("group-cancel-Seniors"));
    await userEvent.click(canvas.getByTestId("group-dup-Seniors"));
    await expect(await groupIds()).toHaveLength(3);
    await userEvent.click(canvas.getByTestId("group-delete-Juniors"));
    await expect(await groupIds()).not.toContain("Juniors");
  },
};

export const Reorder: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("group-move-down-Seniors"));
    await expect(await groupIds()).toEqual(["Juniors", "Seniors"]);
    await waitFor(() => expect(canvas.getByTestId("group-move-up-Seniors")).toBeVisible());
    await userEvent.click(canvas.getByTestId("group-move-up-Seniors"));
    await expect(await groupIds()).toEqual(["Seniors", "Juniors"]);
  },
};

export const LongText: Story = {
  parameters: {
    scenario: { staff: STAFF, staffGroups: [{ id: LONG_TOKEN, members: ["Aisha"] }] },
  },
  decorators: [withNarrowFrame],
  play: async ({ canvas }) => {
    await expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"));
    const row = canvas.getByTestId(`group-row-${LONG_TOKEN}`).getBoundingClientRect();
    const id = canvas.getByTestId(`group-id-text-${LONG_TOKEN}`).getBoundingClientRect();
    await expect(id.right).toBeLessThanOrEqual(row.right);
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
