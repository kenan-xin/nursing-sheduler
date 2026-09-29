import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn } from "storybook/test";
import { WeightField, WeightPill } from "./weight-field";

// Shared soft/hard weight dial + the card-summary weight pill. `WeightField` is a
// fully-controlled field; `WeightPill` is the read-only summary chip.
const meta = {
  title: "CardEditor/WeightField",
  component: WeightField,
  args: { value: 0, onChange: fn() },
} satisfies Meta<typeof WeightField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ args, canvas, userEvent }) => {
    // The field is controlled by `value`, so the typed keystroke appends to "0"
    // and `parseWeightInput("05")` resolves to 5.
    await userEvent.type(canvas.getByRole("textbox", { name: "Weight (priority)" }), "5");
    await expect(args.onChange).toHaveBeenCalledWith(5);
  },
};

export const WithHelp: Story = {
  args: { help: "Positive encourages · negative discourages · ±∞ makes it a hard rule." },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByText("Positive encourages · negative discourages · ±∞ makes it a hard rule."),
    ).toBeVisible();
  },
};

export const WithError: Story = {
  args: {
    error:
      "Weight must be a whole number from -1t to 1t (1,000,000,000,000), Infinity, or -Infinity",
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("alert")).toHaveTextContent(
      "Weight must be a whole number from -1t to 1t (1,000,000,000,000), Infinity, or -Infinity",
    );
  },
};

export const WithNote: Story = {
  args: { note: "Weight is not needed when the preferred number equals the required number." },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByText(
        "Weight is not needed when the preferred number equals the required number.",
      ),
    ).toBeVisible();
    // The note replaces the dial — no input is mounted in this state.
    await expect(canvas.queryByTestId("weight-field-input")).toBeNull();
  },
};

export const Pill: Story = {
  render: () => <WeightPill value={5} />,
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("weight-pill")).toHaveTextContent("WEIGHT +5");
  },
};

export const PillInfinite: Story = {
  render: () => <WeightPill value={Infinity} />,
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("weight-pill")).toHaveTextContent("WEIGHT +∞");
  },
};

// Last on purpose: the next light story would prove the theme reset.
export const Dark: Story = {
  args: { ...WithError.args },
  globals: { theme: "dark" },
};
