import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect } from "storybook/test";
import { AppVersion } from "./app-version";

// `NEXT_PUBLIC_APP_VERSION` is unset under Storybook, so the stamp renders
// `vunknown`. The story asserts only the `v` prefix the component guarantees.
const meta = {
  title: "App/AppVersion",
  component: AppVersion,
} satisfies Meta<typeof AppVersion>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("app-version")).toHaveTextContent(/^v/);
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
