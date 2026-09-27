import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, waitFor } from "storybook/test";
import { RosterContentWidthProvider, useRosterContentWidth } from "./roster-content-width";

// A real ResizeObserver in real Chromium: the measurement path jsdom cannot exercise.
function WidthProbe() {
  const { width, stacked } = useRosterContentWidth();
  return <p>{`width:${width === null ? "null" : Math.round(width)} stacked:${stacked}`}</p>;
}

const meta = {
  title: "RosterViewer/RosterContentWidthProvider",
  component: RosterContentWidthProvider,
  parameters: { layout: "padded" },
  args: { children: <WidthProbe /> },
} satisfies Meta<typeof RosterContentWidthProvider>;

export default meta;
type Story = StoryObj<typeof meta>;

const frame = (className: string): NonNullable<Story["decorators"]> => [
  (Story) => (
    <div data-testid="width-frame" className={className}>
      <Story />
    </div>
  ),
];

export const Wide: Story = {
  decorators: frame("w-[800px]"),
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("width:800 stacked:false")).toBeVisible();
  },
};

export const Narrow: Story = {
  decorators: frame("w-[600px]"),
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("width:600 stacked:true")).toBeVisible();
  },
};

export const Resize: Story = {
  decorators: frame("w-[800px]"),
  play: async ({ canvas }) => {
    await canvas.findByText("width:800 stacked:false");
    canvas.getByTestId("width-frame").style.width = "600px";
    await waitFor(() => expect(canvas.getByText("width:600 stacked:true")).toBeVisible());
  },
};

// A consumer outside the provider gets the conservative desktop fallback.
export const Fallback: Story = {
  render: () => <WidthProbe />,
  play: async ({ canvas }) => {
    await expect(canvas.getByText("width:null stacked:false")).toBeVisible();
  },
};

export const Dark: Story = {
  decorators: frame("w-[800px]"),
  globals: { theme: "dark" },
};
