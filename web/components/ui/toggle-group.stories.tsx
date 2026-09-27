import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent } from "storybook/test";
import { ToggleGroup, ToggleGroupItem } from "./toggle-group";

const meta = {
  title: "UI/ToggleGroup",
  component: ToggleGroup,
  args: { onValueChange: fn() },
} satisfies Meta<typeof ToggleGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Segmented: Story = {
  render: (args) => (
    <ToggleGroup {...args} segmented aria-label="Roster period">
      <ToggleGroupItem value="week">Week</ToggleGroupItem>
      <ToggleGroupItem value="month">Month</ToggleGroupItem>
    </ToggleGroup>
  ),
  play: async ({ args, canvas, userEvent }) => {
    const week = canvas.getByRole("button", { name: "Week" });
    await userEvent.click(week);
    await expect(week).toHaveAttribute("aria-pressed", "true");
    // Base UI's ToggleGroup is single-select by default, so the value is a one-item array.
    await expect(args.onValueChange).toHaveBeenCalledWith(["week"], expect.anything());
  },
};

export const Outline: Story = {
  render: (args) => (
    <ToggleGroup {...args} variant="outline" aria-label="Density">
      <ToggleGroupItem value="compact">Compact</ToggleGroupItem>
      <ToggleGroupItem value="roomy">Roomy</ToggleGroupItem>
    </ToggleGroup>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: "Compact" })).toBeVisible();
  },
};

export const Small: Story = {
  render: (args) => (
    <ToggleGroup {...args} size="sm" aria-label="Density">
      <ToggleGroupItem value="compact">Compact</ToggleGroupItem>
      <ToggleGroupItem value="roomy">Roomy</ToggleGroupItem>
    </ToggleGroup>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: "Compact" })).toBeVisible();
  },
};

export const Large: Story = {
  render: (args) => (
    <ToggleGroup {...args} size="lg" aria-label="Density">
      <ToggleGroupItem value="compact">Compact</ToggleGroupItem>
      <ToggleGroupItem value="roomy">Roomy</ToggleGroupItem>
    </ToggleGroup>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: "Compact" })).toBeVisible();
  },
};

// The accent control's geometry: a real 32px square item whose whole content is a
// colour chip. The chip is a token fill, never a literal.
export const Swatch: Story = {
  render: (args) => (
    <ToggleGroup {...args} size="swatch" aria-label="Accent colour">
      <ToggleGroupItem value="teal" aria-label="Teal">
        <span className="size-4 rounded-full bg-brand" />
      </ToggleGroupItem>
      <ToggleGroupItem value="sage" aria-label="Sage">
        <span className="size-4 rounded-full bg-ink3" />
      </ToggleGroupItem>
    </ToggleGroup>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: "Teal" })).toBeVisible();
  },
};

export const Disabled: Story = {
  render: (args) => (
    <ToggleGroup {...args} disabled aria-label="Roster period">
      <ToggleGroupItem value="week">Week</ToggleGroupItem>
      <ToggleGroupItem value="month">Month</ToggleGroupItem>
    </ToggleGroup>
  ),
  play: async ({ args, canvas }) => {
    const week = canvas.getByRole("button", { name: "Week" });
    await expect(week).toBeDisabled();
    // A disabled item carries `disabled:pointer-events-none`, so the direct userEvent
    // API would refuse to aim at it. The dedicated instance skips that check; user-event
    // then declines to dispatch a click at a natively disabled button at all.
    const pointer = userEvent.setup({ pointerEventsCheck: 0 });
    await pointer.click(week);
    await expect(args.onValueChange).not.toHaveBeenCalled();
  },
};

// The segmented well is the file's richest state (a recessed track with a pressed
// `--brandtint` item), so it is the one worth checking under the dark ramp.
export const Dark: Story = {
  render: (args) => (
    <ToggleGroup {...args} segmented defaultValue={["week"]} aria-label="Roster period">
      <ToggleGroupItem value="week">Week</ToggleGroupItem>
      <ToggleGroupItem value="month">Month</ToggleGroupItem>
    </ToggleGroup>
  ),
  globals: { theme: "dark" },
};
