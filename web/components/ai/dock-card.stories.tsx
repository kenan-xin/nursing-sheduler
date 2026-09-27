import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn } from "storybook/test";
import {
  LONG_PROSE,
  LONG_TOKEN,
  expectNoHorizontalOverflow,
  withNarrowFrame,
} from "../../.storybook/story-helpers";
import { DockCard, DockServicesContext } from "./dock-card";

// Nested handler spies are module-level (Storybook tracks only meta-arg spies), so
// clear them before every story.
const focusComposer = fn();
const announce = fn();
const pickFirst = fn();
const pickSecond = fn();
const pickThird = fn();
const sendOther = fn();
const sendMultiple = fn();

// DockCard takes focus on mount only from `body` (or inside the assistant panel); a story
// mounts with focus on `body`, so the keyboard plays can press keys straight away.
const meta = {
  title: "AI/DockCard",
  component: DockCard,
  decorators: [
    (Story) => (
      <DockServicesContext.Provider value={{ focusComposer, announce }}>
        <div className="w-96">
          <Story />
        </div>
      </DockServicesContext.Provider>
    ),
  ],
  beforeEach: () => {
    for (const spy of [
      focusComposer,
      announce,
      pickFirst,
      pickSecond,
      pickThird,
      sendOther,
      sendMultiple,
    ]) {
      spy.mockClear();
    }
  },
  args: {
    title: "Who covers Sunday's late+?",
    rowsLabel: "Your answer",
    onClose: fn(),
    onSkip: fn(),
    options: [
      { label: "Priya (early1 → late+)", onPick: pickFirst },
      { label: "Leave it uncovered", detail: "Counts as a shortfall", onPick: pickSecond },
    ],
    other: {
      label: "Something else",
      sendLabel: "Send answer",
      disabled: false,
      onSend: sendOther,
    },
  },
} satisfies Meta<typeof DockCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Question: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await expect(announce).toHaveBeenCalledWith("Who covers Sunday's late+?");
    await userEvent.keyboard("2");
    await expect(pickSecond).toHaveBeenCalledOnce();
    await userEvent.keyboard("{ArrowDown}");
    await expect(canvas.getByRole("button", { name: /Priya/ })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    await expect(canvas.getByRole("button", { name: /Leave it uncovered/ })).toHaveFocus();
    await userEvent.type(canvas.getByRole("textbox", { name: "Something else" }), "N12 cover");
    await userEvent.keyboard("{Enter}");
    await expect(sendOther).toHaveBeenCalledOnce();
    await expect(sendOther).toHaveBeenCalledWith("N12 cover");
    await userEvent.keyboard("{Escape}");
    await expect(args.onClose).toHaveBeenCalledOnce();
    await expect(focusComposer).toHaveBeenCalledOnce();
  },
};

export const Decision: Story = {
  args: {
    focusRow: 0,
    other: null,
    options: [
      { label: "Apply the swap", primary: true, onPick: pickFirst },
      { label: "Set it aside", onPick: pickSecond },
    ],
  },
  play: async ({ canvas, userEvent }) => {
    await expect(canvas.getByRole("button", { name: "Apply the swap" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect(pickFirst).toHaveBeenCalledOnce();
    await expect(pickSecond).not.toHaveBeenCalled();
  },
};

const THREE_OPTIONS = [
  { label: "early1", onPick: pickFirst },
  { label: "late+", onPick: pickSecond },
  { label: "N12", onPick: pickThird },
];

export const Multiple: Story = {
  args: { options: THREE_OPTIONS, multiple: { disabled: false, onSend: sendMultiple } },
  play: async ({ canvas, userEvent }) => {
    const first = canvas.getByRole("checkbox", { name: "early1" });
    const third = canvas.getByRole("checkbox", { name: "N12" });
    await userEvent.click(first);
    await userEvent.click(third);
    await expect(first).toHaveAttribute("aria-checked", "true");
    await expect(canvas.getByRole("checkbox", { name: "late+" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await expect(third).toHaveAttribute("aria-checked", "true");
    await userEvent.click(canvas.getByRole("button", { name: "Send selected" }));
    await expect(sendMultiple).toHaveBeenCalledOnce();
    await expect(sendMultiple).toHaveBeenCalledWith([0, 2], "");
    await expect(pickFirst).not.toHaveBeenCalled();
  },
};

export const DisabledRows: Story = {
  args: {
    options: [
      { label: "Priya (early1 → late+)", disabled: true, onPick: pickFirst },
      { label: "Leave it uncovered", disabled: true, onPick: pickSecond },
    ],
  },
  play: async ({ canvas, userEvent }) => {
    const row = canvas.getByRole("button", { name: /Priya/ });
    await expect(row).toBeDisabled();
    // A native click: a disabled button fires nothing, whatever userEvent would refuse.
    row.click();
    await userEvent.keyboard("1");
    await expect(pickFirst).not.toHaveBeenCalled();
  },
};

export const SkipOnly: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Skip" }));
    await expect(args.onSkip).toHaveBeenCalledOnce();
    await expect(sendOther).not.toHaveBeenCalled();
  },
};

// Title and option labels are assistant prose: they wrap, never truncate.
export const LongText: Story = {
  decorators: [withNarrowFrame],
  args: {
    title: LONG_PROSE,
    options: [{ label: LONG_TOKEN, onPick: pickFirst }],
  },
  play: async ({ canvas }) => {
    await expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"));
  },
};

export const Dark: Story = {
  args: { ...Question.args },
  globals: { theme: "dark" },
};
