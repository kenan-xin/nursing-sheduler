import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect } from "storybook/test";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  SelectedCard,
} from "./card";

const meta = {
  title: "UI/Card",
  component: Card,
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

// The width lives on a plain wrapper: a surface consumer's `className` is held to
// the layout allowlist by the `surface-consumer-classname` ast-grep rule, and the
// card owns its own paint.
function Resolved() {
  return (
    <div className="w-80">
      <Card>
        <CardHeader>
          <CardTitle>Night cover</CardTitle>
          <CardDescription>Applies to every night shift in the period.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-body text-ink">Minimum two nurses on duty after 22:00.</p>
        </CardContent>
        <CardFooter>
          <span className="text-meta text-ink2">Edited 4 minutes ago</span>
        </CardFooter>
      </Card>
    </div>
  );
}

export const Default: Story = {
  render: () => <Resolved />,
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Night cover")).toBeVisible();
    await expect(canvas.getByText("Applies to every night shift in the period.")).toBeVisible();
    await expect(canvas.getByText("Edited 4 minutes ago")).toBeVisible();
  },
};

export const Selected: Story = {
  render: () => (
    <div className="w-80">
      <SelectedCard>
        <CardHeader>
          <CardTitle>Night cover</CardTitle>
          <CardDescription>Currently open in the card editor.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-body text-ink">Minimum two nurses on duty after 22:00.</p>
        </CardContent>
      </SelectedCard>
    </div>
  ),
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByText("Night cover")).toBeVisible();
    // DESIGN.md §4: a selected card swaps the hairline for a `--brand` border.
    await expect(canvasElement.querySelector("[data-slot='card']")).toHaveAttribute(
      "data-selected",
      "true",
    );
  },
};

export const Dark: Story = {
  render: () => <Resolved />,
  globals: { theme: "dark" },
};
