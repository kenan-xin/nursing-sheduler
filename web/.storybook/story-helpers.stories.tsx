import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect } from "storybook/test";
import {
  LONG_PROSE,
  LONG_TOKEN,
  expectNoHorizontalOverflow,
  withNarrowFrame,
} from "./story-helpers";

// Helper self-checks (bead w0e.3). Hidden from the sidebar, run by `pnpm test:stories`.
const meta = {
  title: "Harness/StoryHelpers",
  tags: ["!dev"],
  decorators: [withNarrowFrame],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Fixtures: Story = {
  render: () => <p>{LONG_PROSE}</p>,
  play: async () => {
    await expect(LONG_TOKEN).toHaveLength(120);
    await expect(LONG_TOKEN).not.toMatch(/\s/);
    await expect(LONG_PROSE.length).toBeGreaterThan(120);
  },
};

export const TruncatedIsContained: Story = {
  render: () => (
    <p className="truncate" title={LONG_TOKEN}>
      {LONG_TOKEN}
    </p>
  ),
  play: async ({ canvas }) => {
    await expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"));
    const text = canvas.getByTitle(LONG_TOKEN);
    // Proves the ellipsis is really in play, not that the token happened to fit.
    await expect(text.scrollWidth).toBeGreaterThan(text.clientWidth);
  },
};

export const OverflowIsCaught: Story = {
  render: () => <p className="whitespace-nowrap">{LONG_TOKEN}</p>,
  play: async ({ canvas }) => {
    await expect(expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"))).rejects.toThrow();
  },
};
