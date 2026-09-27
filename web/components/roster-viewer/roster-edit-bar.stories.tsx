import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, screen, waitFor } from "storybook/test";
import type { RosterContext } from "@/lib/roster";
import { priyaContext } from "@/lib/roster-viewer/swap-fixtures";
import {
  LONG_TOKEN,
  expectNoHorizontalOverflow,
  withNarrowFrame,
} from "../../.storybook/story-helpers";
import { RosterEditBar } from "./roster-edit-bar";

function contextWithLongPerson(): RosterContext {
  const base = priyaContext();
  return { ...base, people: [{ id: LONG_TOKEN }, ...base.people.slice(1)] };
}

const meta = {
  title: "RosterViewer/RosterEditBar",
  component: RosterEditBar,
  parameters: { layout: "padded" },
  args: {
    context: priyaContext(),
    selected: { personIdx: 0, dateIdx: 0 },
    current: { kind: "shift", shiftId: "AM" },
    onSetCell: fn(),
    onCancel: fn(),
  },
} satisfies Meta<typeof RosterEditBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ShiftSelected: Story = {
  play: async ({ args, userEvent }) => {
    // The shift chooser is a Base UI Combobox, so its popup is portalled.
    await userEvent.click(screen.getByTestId("roster-shift-picker"));
    const option = await screen.findByTestId("roster-shift-option-PM");
    await userEvent.click(option);
    await expect(args.onSetCell).toHaveBeenCalledWith(
      { personIdx: 0, dateIdx: 0 },
      { kind: "shift", shiftId: "PM" },
    );
  },
};

export const LeaveSelected: Story = {
  args: { selected: { personIdx: 1, dateIdx: 1 }, current: { kind: "leave" } },
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByTestId("roster-edit-current")).toHaveTextContent("now Leave");
    await userEvent.click(canvas.getByTestId("roster-edit-option-LV"));
    await expect(args.onSetCell).toHaveBeenCalledWith(
      { personIdx: 1, dateIdx: 1 },
      { kind: "leave" },
    );
  },
};

export const NoMatch: Story = {
  // a11y violation tracked in nursing-sheduler-w0e.13; restore "error" when fixed.
  // While the picker popup is open, Base UI marks the bar's own focusable siblings
  // (OFF/LV, Cancel) `aria-hidden`, which axe reports as `aria-hidden-focus`.
  parameters: { a11y: { test: "todo" } },
  play: async ({ userEvent }) => {
    await userEvent.click(screen.getByTestId("roster-shift-picker"));
    await userEvent.type(screen.getByTestId("roster-shift-picker"), "zzz");
    const empty = await screen.findByText("No shift matches that search.");
    await waitFor(() => expect(empty).toBeVisible());
  },
};

export const LongText: Story = {
  decorators: [withNarrowFrame],
  args: { context: contextWithLongPerson() },
  play: async ({ canvas }) => {
    await expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"));
  },
};

export const Dark: Story = {
  args: { ...LeaveSelected.args },
  globals: { theme: "dark" },
};
