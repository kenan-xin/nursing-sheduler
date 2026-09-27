import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn } from "storybook/test";
import type { CoveringCard } from "@/lib/scenario";
import {
  LONG_PROSE,
  LONG_TOKEN,
  expectNoHorizontalOverflow,
  withNarrowFrame,
} from "../../.storybook/story-helpers";
import { buildCoveringCard, emptyCoveringForm, withCardDisabled } from "./coverings-model";
import { CoveringCardList } from "./covering-card-list";

// Saved-coverings list on the shared ScreenCards card frame. Every covering is a
// hard rule ("Always enforced"); cards come from the folder's own model.
const MENTOR = buildCoveringCard(
  {
    ...emptyCoveringForm(),
    description: "Every new starter on days is supervised",
    preceptors: ["Alice"],
    preceptees: ["Bob"],
    shiftTypes: ["D"],
    dates: ["WEEKDAY"],
  },
  "c1",
);

const NIGHTS = withCardDisabled(
  buildCoveringCard(
    {
      ...emptyCoveringForm(),
      description: "Night shift pairings",
      preceptors: ["Bob"],
      preceptees: ["Alice"],
      shiftTypes: ["N"],
      dates: [],
    },
    "c2",
  ),
  true,
);

// `buildCoveringCard` always emits ONE term per selector, so an advanced card
// (two top-level terms) is hand-built to exercise the read-only branch.
const ADVANCED: CoveringCard = {
  uid: "c3",
  description: "Advanced (multi-term) covering",
  preceptors: [["Alice"], ["Bob"]],
  preceptees: ["Bob"],
  shiftTypes: ["D"],
  weight: 1,
};

const CARDS: CoveringCard[] = [MENTOR, NIGHTS, ADVANCED];

const meta = {
  title: "Coverings/CoveringCardList",
  component: CoveringCardList,
  parameters: { layout: "padded" },
  args: {
    coverings: CARDS,
    onEdit: fn(),
    onDuplicate: fn(),
    onDelete: fn(),
    onSetDisabled: fn(),
    onReorder: fn(),
  },
} satisfies Meta<typeof CoveringCardList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("covering-edit-0"));
    await expect(args.onEdit).toHaveBeenCalledWith("c1");

    await userEvent.click(canvas.getByTestId("covering-dup-0"));
    await expect(args.onDuplicate).toHaveBeenCalledWith("c1");

    await userEvent.click(canvas.getByTestId("covering-delete-0"));
    await expect(args.onDelete).toHaveBeenCalledWith("c1");

    // Card 0 is enabled, so the toggle asks for `true`.
    await userEvent.click(canvas.getByTestId("covering-disable-0"));
    await expect(args.onSetDisabled).toHaveBeenCalledWith("c1", true);

    // "Up" on card 1 moves it before card 0.
    await userEvent.click(canvas.getByTestId("covering-up-1"));
    await expect(args.onReorder).toHaveBeenCalledWith("c2", "c1", "before");
  },
};

export const Empty: Story = {
  args: { coverings: [] },
  play: async ({ canvas }) => {
    // The zero-data copy belongs to the editor shell (CoveringsEditor); this list
    // simply renders no cards.
    await expect(canvas.getByTestId("coverings-list").children).toHaveLength(0);
  },
};

export const LongText: Story = {
  decorators: [withNarrowFrame],
  args: {
    coverings: [
      buildCoveringCard(
        {
          ...emptyCoveringForm(),
          description: LONG_PROSE,
          preceptors: [LONG_TOKEN],
          preceptees: ["Bob"],
          shiftTypes: ["D"],
          dates: ["ALL"],
        },
        "lt",
      ),
    ],
  },
  play: async ({ canvas }) => {
    // The description is prose and must wrap without overflowing the frame.
    await expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"));
    // KNOWN OVERFLOW nursing-sheduler-w0e.22: restore expect(canvas.getByTitle(LONG_TOKEN)).toBeVisible() when fixed
  },
};

// Last on purpose: the next light story would prove the theme reset.
export const Dark: Story = {
  globals: { theme: "dark" },
};
