import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, screen, waitFor } from "storybook/test";
import { expectNoHorizontalOverflow, LONG_TOKEN } from "../../.storybook/story-helpers";
import { HistoryEditor, type HistoryOption } from "./history-editor";

// Worked items + OFF + LEAVE only — history carries no groups (spec 04).
const OPTIONS: HistoryOption[] = [
  { id: "early1", label: "Early" },
  { id: "late+", label: "Late" },
  { id: "N12", label: "Night 12h" },
  { id: "OFF", label: "Off / rest day" },
  { id: "LEAVE", label: "Paid leave" },
];

// Portalled (Base UI Dialog): query with `screen`, never `canvas`.
const meta = {
  title: "Requests/HistoryEditor",
  component: HistoryEditor,
  args: {
    open: true,
    who: "Kevin Ong",
    positionLabel: "H-2",
    currentValue: null,
    options: OPTIONS,
    onSet: fn(),
    onClear: fn(),
    onClose: fn(),
  },
} satisfies Meta<typeof HistoryEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {
  play: async ({ args, userEvent }) => {
    // The popup fades in, so wait for the animation to settle before asserting visibility.
    await waitFor(() => expect(screen.getByTestId("history-editor")).toBeVisible());
    await userEvent.click(screen.getByTestId("history-editor-option-early1"));
    await expect(args.onSet).toHaveBeenCalledOnce();
    await expect(args.onSet).toHaveBeenCalledWith("early1");
    await userEvent.click(screen.getByTestId("history-editor-clear"));
    await expect(args.onClear).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByTestId("history-editor-done"));
    await expect(args.onClose).toHaveBeenCalledOnce();
  },
};

export const WithCurrentValue: Story = {
  args: { currentValue: "OFF" },
  play: async () => {
    await expect(await screen.findByTestId("history-editor-option-OFF")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(screen.getByTestId("history-editor-option-early1")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  },
};

export const LongText: Story = {
  args: {
    who: LONG_TOKEN,
    options: [{ id: "long", label: LONG_TOKEN }, ...OPTIONS],
  },
  play: async () => {
    await waitFor(() => expect(screen.getByTestId("history-editor")).toBeVisible());
    await expectNoHorizontalOverflow(screen.getByTestId("history-editor"));
  },
};

export const Dark: Story = {
  args: { ...WithCurrentValue.args },
  globals: { theme: "dark" },
};
