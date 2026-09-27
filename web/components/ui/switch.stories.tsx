import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn } from "storybook/test";
import { Switch } from "./switch";

const meta = {
  title: "UI/Switch",
  component: Switch,
  args: { "aria-label": "Prettify output", onCheckedChange: fn() },
} satisfies Meta<typeof Switch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Off: Story = {
  play: async ({ args, canvas, userEvent }) => {
    const control = canvas.getByRole("switch", { name: "Prettify output" });
    await expect(control).toHaveAttribute("aria-checked", "false");
    await userEvent.click(control);
    await expect(control).toHaveAttribute("aria-checked", "true");
    await expect(args.onCheckedChange).toHaveBeenCalledWith(true, expect.anything());
  },
};

export const On: Story = {
  args: { defaultChecked: true },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("switch", { name: "Prettify output" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  },
};

// The root is a `<span role="switch">` (Base UI grows the real control for the
// coarse-pointer floor), so the disabled state is published as `aria-disabled`
// rather than the `disabled` attribute a form control would carry.
export const Disabled: Story = {
  args: { disabled: true },
  play: async ({ args, canvas, userEvent }) => {
    const control = canvas.getByRole("switch", { name: "Prettify output" });
    await expect(control).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(control);
    await expect(args.onCheckedChange).not.toHaveBeenCalled();
  },
};

// The checked track is `--brand`; that fill/ink pair is the one worth checking in dark.
export const Dark: Story = {
  args: { ...On.args },
  globals: { theme: "dark" },
};
