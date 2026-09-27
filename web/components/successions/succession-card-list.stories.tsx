import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn } from "storybook/test";
import {
  LONG_PROSE,
  LONG_TOKEN,
  expectNoHorizontalOverflow,
  withNarrowFrame,
} from "../../.storybook/story-helpers";
import { buildSuccessionCard, type SuccessionFormState } from "./successions-model";
import type { SuccessionCard } from "@/lib/scenario";
import { SuccessionCardList } from "./succession-card-list";

// Cards come from the model's own builder, never hand-typed aggregates.
function card(overrides: Partial<SuccessionFormState>, uid: string): SuccessionCard {
  return buildSuccessionCard(
    {
      description: "",
      person: [],
      pattern: ["N", "D"],
      date: [],
      weight: -1,
      ...overrides,
    },
    uid,
  );
}

// A nested-aggregate pattern position: the sequential form cannot author it, so the
// list renders it read-only with an `Advanced (nested)` badge.
const ADVANCED: SuccessionCard = {
  ...card({ description: "Nested aggregate pattern", person: ["Alice"] }, "s3"),
  pattern: [["N", "E"], "D"],
};

const POPULATED: SuccessionCard[] = [
  card(
    { description: "No Evening → Day", person: ["Alice"], pattern: ["E", "D"], weight: -5 },
    "s1",
  ),
  { ...card({ person: ["Bob"], pattern: ["N", "E"], weight: 3 }, "s2"), disabled: true },
  ADVANCED,
];

const meta = {
  title: "Successions/SuccessionCardList",
  component: SuccessionCardList,
  parameters: { layout: "padded" },
  args: {
    successions: POPULATED,
    onEdit: fn(),
    onDuplicate: fn(),
    onDelete: fn(),
    onSetDisabled: fn(),
    onReorder: fn(),
  },
} satisfies Meta<typeof SuccessionCardList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("succession-edit-0"));
    await expect(args.onEdit).toHaveBeenCalledWith("s1");

    await userEvent.click(canvas.getByTestId("succession-dup-0"));
    await expect(args.onDuplicate).toHaveBeenCalledWith("s1");

    await userEvent.click(canvas.getByTestId("succession-delete-0"));
    await expect(args.onDelete).toHaveBeenCalledWith("s1");

    // The toggle on an ENABLED card (index 0, "s1") asks to disable it.
    await userEvent.click(canvas.getByTestId("succession-disable-0"));
    await expect(args.onSetDisabled).toHaveBeenCalledWith("s1", true);

    // Keyboard reorder: card 1 up is "before" card 0.
    await userEvent.click(canvas.getByTestId("succession-up-1"));
    await expect(args.onReorder).toHaveBeenCalledWith("s2", "s1", "before");

    // The advanced card has no Edit action, only a read-only note.
    await expect(canvas.queryByTestId("succession-edit-2")).toBeNull();
    await expect(canvas.getByTestId("succession-readonly-note-2")).toBeVisible();
  },
};

export const Empty: Story = {
  args: { successions: [] },
  play: async ({ canvas }) => {
    // The list itself has no empty-state copy — the editor renders that — so this
    // pins the honest contract: a present, empty list.
    await expect(canvas.getByTestId("successions-list").children).toHaveLength(0);
    await expect(canvas.queryByTestId("succession-card-0")).toBeNull();
  },
};

export const LongText: Story = {
  decorators: [withNarrowFrame],
  args: {
    successions: [
      card({ description: LONG_PROSE, person: [LONG_TOKEN], pattern: ["E", "D"] }, "s1"),
    ],
  },
  play: async ({ canvas }) => {
    await expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"));
  },
};

export const Dark: Story = {
  args: { ...Populated.args },
  globals: { theme: "dark" },
};
