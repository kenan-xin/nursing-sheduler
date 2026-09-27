import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, screen } from "storybook/test";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";

// Floating-ui canary (storybookjs/storybook#35546): a `defaultOpen` Base UI popup must
// be positioned under its trigger, not parked off-screen.
const meta = {
  title: "UI/DropdownMenu",
  component: DropdownMenu,
  args: { defaultOpen: true },
  render: (args) => (
    <DropdownMenu {...args}>
      <DropdownMenuTrigger>Roster file</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Import</DropdownMenuItem>
        <DropdownMenuItem>Export</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
} satisfies Meta<typeof DropdownMenu>;

export default meta;

export const DefaultOpen: StoryObj<typeof meta> = {
  play: async ({ canvas }) => {
    const trigger = canvas.getByRole("button", { name: "Roster file" }).getBoundingClientRect();
    const popup = (await screen.findByRole("menu")).getBoundingClientRect();
    await expect(popup.top).toBeGreaterThanOrEqual(trigger.bottom);
    await expect(popup.bottom).toBeLessThanOrEqual(window.innerHeight);
  },
};
