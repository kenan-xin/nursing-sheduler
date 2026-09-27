import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect } from "storybook/test";
import type { RosterDayState } from "@/lib/roster";
import { SHIFT_FAMILY_RAMP } from "@/lib/roster-viewer";
import { LONG_TOKEN } from "../../.storybook/story-helpers";
import { ShiftChip } from "./shift-chip";

function shift(shiftId: string): RosterDayState {
  return { kind: "shift", shiftId };
}

const meta = {
  title: "RosterViewer/ShiftChip",
  component: ShiftChip,
  args: { day: shift("early1"), ramp: SHIFT_FAMILY_RAMP.morning },
} satisfies Meta<typeof ShiftChip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Morning: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByLabelText("early1")).toHaveAccessibleName("early1");
  },
};

export const Evening: Story = {
  args: { day: shift("late+"), ramp: SHIFT_FAMILY_RAMP.evening },
  play: async ({ canvas }) => {
    await expect(canvas.getByLabelText("late+")).toHaveAccessibleName("late+");
  },
};

export const LongDay: Story = {
  args: { day: shift("N12"), ramp: SHIFT_FAMILY_RAMP.long },
  play: async ({ canvas }) => {
    await expect(canvas.getByLabelText("N12")).toHaveAccessibleName("N12");
  },
};

export const Night: Story = {
  args: { day: shift("night1"), ramp: SHIFT_FAMILY_RAMP.night },
  play: async ({ canvas }) => {
    await expect(canvas.getByLabelText("night1")).toHaveAccessibleName("night1");
  },
};

export const Other: Story = {
  args: { day: shift("twilight"), ramp: SHIFT_FAMILY_RAMP.other },
  play: async ({ canvas }) => {
    await expect(canvas.getByLabelText("twilight")).toHaveAccessibleName("twilight");
  },
};

export const Leave: Story = {
  args: { day: { kind: "leave" }, ramp: null },
  play: async ({ canvas }) => {
    await expect(canvas.getByLabelText("Leave")).toBeVisible();
  },
};

export const Off: Story = {
  args: { day: { kind: "off" }, ramp: null },
  play: async ({ canvas }) => {
    await expect(canvas.getByLabelText("Off")).toBeVisible();
  },
};

// DESIGN.md §5: a long authored id GROWS the chip rather than clipping it, so the
// assertion is containment (the chip's own box holds its content), not truncation.
export const LongId: Story = {
  args: { day: shift(LONG_TOKEN), ramp: SHIFT_FAMILY_RAMP.morning },
  play: async ({ canvas }) => {
    const chip = canvas.getByLabelText(LONG_TOKEN);
    await expect(chip.scrollWidth).toBeLessThanOrEqual(chip.clientWidth);
  },
};

export const Dark: Story = {
  args: { ...Night.args },
  globals: { theme: "dark" },
};
