import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn } from "storybook/test";
import {
  LONG_PROSE,
  expectNoHorizontalOverflow,
  withNarrowFrame,
} from "../../.storybook/story-helpers";
import { RuleRow } from "./rule-row";
import type { GuidedRuleRow } from "./types";

// One record-backed row with two quick fields (a plain count and a soft/hard weight).
const ROW: GuidedRuleRow = {
  id: "requirements:r1",
  source: "record",
  kind: "requirements",
  constraintId: "r1",
  category: "Staffing",
  title: "Day cover",
  summary: "At least 2 people on late+ every day.",
  enabled: true,
  locked: false,
  advancedRoute: "/shift-requirements",
  quickFields: [
    {
      key: "requiredNumPeople",
      label: "People",
      value: 2,
      min: 0,
      validate: (v) => (v < 0 ? "Must be 0 or more" : undefined),
    },
    {
      key: "weight",
      label: "Weight",
      value: -1,
      allowsInfinity: true,
      validate: (v) => (Number.isNaN(v) ? "Enter a weight" : undefined),
    },
  ],
};

const meta = {
  title: "GuidedRules/RuleRow",
  component: RuleRow,
  parameters: { layout: "padded" },
  // RuleRow is an <li>; the screen mounts it inside a category <ul>.
  render: (args) => (
    <ul className="m-0 list-none p-0">
      <RuleRow {...args} />
    </ul>
  ),
  args: {
    row: ROW,
    adjustOpen: false,
    onToggleAdjust: fn(),
    onToggleEnabled: fn(),
    onOpenAdvanced: fn(),
    renaming: false,
    renameDraft: "",
    onRenameStart: fn(),
    onRenameDraftChange: fn(),
    onRenameCancel: fn(),
    onRenameSubmit: fn(),
    onAdjustField: fn((): string | undefined => undefined),
  },
} satisfies Meta<typeof RuleRow>;

export default meta;
type Story = StoryObj<typeof meta>;

const id = ROW.id;

export const Enabled: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByText("ON")).toBeVisible();
    await userEvent.click(canvas.getByTestId(`rule-toggle-${id}`));
    await expect(args.onToggleEnabled).toHaveBeenCalledOnce();
    await expect(args.onToggleEnabled).toHaveBeenCalledWith(false, expect.anything());
    await userEvent.click(canvas.getByTestId(`rule-open-advanced-${id}`));
    await expect(args.onOpenAdvanced).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByTestId(`rule-adjust-toggle-${id}`));
    await expect(args.onToggleAdjust).toHaveBeenCalledOnce();
  },
};

export const Off: Story = {
  args: { row: { ...ROW, enabled: false } },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("OFF")).toBeVisible();
    await expect(canvas.getByTestId(`rule-row-${id}`)).toHaveAttribute("data-disabled", "true");
    // Adjust is only offered on an enabled, unlocked row.
    await expect(canvas.queryByTestId(`rule-adjust-toggle-${id}`)).toBeNull();
  },
};

export const AdjustOpen: Story = {
  args: { adjustOpen: true },
  play: async ({ args, canvas, userEvent }) => {
    const people = canvas.getByTestId(`rule-adjust-input-${id}-requiredNumPeople`);
    await userEvent.clear(people);
    await userEvent.type(people, "3{Enter}");
    await expect(args.onAdjustField).toHaveBeenCalledWith("requiredNumPeople", 3);
    await userEvent.click(canvas.getByTestId(`rule-adjust-plus-inf-${id}-weight`));
    await expect(args.onAdjustField).toHaveBeenCalledWith("weight", Infinity);
    await userEvent.click(canvas.getByTestId(`rule-adjust-done-${id}`));
    await expect(args.onToggleAdjust).toHaveBeenCalledOnce();
  },
};

export const AdjustError: Story = {
  args: { adjustOpen: true, onAdjustField: fn(() => "Must be 1–7") },
  play: async ({ args, canvas, userEvent }) => {
    const people = canvas.getByTestId(`rule-adjust-input-${id}-requiredNumPeople`);
    await userEvent.clear(people);
    await userEvent.type(people, "9{Enter}");
    await expect(args.onAdjustField).toHaveBeenCalledWith("requiredNumPeople", 9);
    await expect(canvas.getByRole("alert")).toHaveTextContent("Must be 1–7");
  },
};

export const Renaming: Story = {
  args: { renaming: true, renameDraft: "Day cover" },
  play: async ({ args, canvas, userEvent }) => {
    const input = canvas.getByTestId(`rule-rename-input-${id}`);
    await userEvent.type(input, "s");
    await expect(args.onRenameDraftChange).toHaveBeenCalledWith("Day covers");
    await userEvent.type(input, "{Enter}");
    await expect(args.onRenameSubmit).toHaveBeenCalledOnce();
    await userEvent.type(input, "{Escape}");
    await expect(args.onRenameCancel).toHaveBeenCalledOnce();
  },
};

export const LongText: Story = {
  args: { row: { ...ROW, title: LONG_PROSE, summary: LONG_PROSE } },
  decorators: [withNarrowFrame],
  play: async ({ canvas }) => {
    await expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"));
  },
};

export const Dark: Story = {
  args: { adjustOpen: true },
  globals: { theme: "dark" },
};
