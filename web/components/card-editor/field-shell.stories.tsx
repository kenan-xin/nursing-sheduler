import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect } from "storybook/test";
import { Input } from "@/components/ui/input";
import { FieldShell } from "./field-shell";

// Shared per-field shell (ScreenCards field cell): label row with optional inline
// hint, the control, then the verbatim error line. Presentational, no handlers.
const meta = {
  title: "CardEditor/FieldShell",
  component: FieldShell,
  args: {
    label: "Description",
    children: <Input placeholder="e.g. Encourage newcomers and seniors to work together" />,
  },
} satisfies Meta<typeof FieldShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Description")).toBeVisible();
  },
};

export const Required: Story = {
  args: { required: true },
  play: async ({ canvas }) => {
    // The required marker is the red asterisk appended to the label. The asterisk
    // is its own element, so assert against the label row's full text content.
    await expect(canvas.getByText("Description").textContent).toContain("*");
  },
};

export const WithHint: Story = {
  args: { hint: "optional" },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("optional")).toBeVisible();
  },
};

export const WithError: Story = {
  args: { error: "Weight must be a valid number, Infinity, or -Infinity" },
  play: async ({ canvas }) => {
    // The error line is announced, not just painted (role="alert").
    await expect(canvas.getByRole("alert")).toHaveTextContent(
      "Weight must be a valid number, Infinity, or -Infinity",
    );
  },
};

// Last on purpose: the next light story would prove the theme reset.
export const Dark: Story = {
  args: { ...WithError.args },
  globals: { theme: "dark" },
};
