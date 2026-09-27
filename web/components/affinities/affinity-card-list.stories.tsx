import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn } from "storybook/test";
import type { AffinityCard } from "@/lib/scenario";
import {
  LONG_PROSE,
  LONG_TOKEN,
  expectNoHorizontalOverflow,
  withNarrowFrame,
} from "../../.storybook/story-helpers";
import { buildAffinityCard, emptyAffinityForm, withCardDisabled } from "./affinities-model";
import { AffinityCardList } from "./affinity-card-list";

// Saved-affinities list on the shared ScreenCards card frame. Cards are built by
// the folder's own model, not hand-typed.
const ENCOURAGE = buildAffinityCard(
  {
    ...emptyAffinityForm(),
    description: "Encourage newcomers and seniors to work together",
    people1: ["Alice"],
    people2: ["Bob"],
    shiftTypes: ["D"],
    date: ["ALL"],
    weight: 10,
  },
  "a1",
);

const DISABLED = withCardDisabled(
  buildAffinityCard(
    {
      ...emptyAffinityForm(),
      description: "Keep the night team together",
      people1: ["Bob"],
      people2: ["Alice"],
      shiftTypes: ["N"],
      date: ["WEEKEND"],
      weight: -5,
    },
    "a2",
  ),
  true,
);

const HARD = buildAffinityCard(
  {
    ...emptyAffinityForm(),
    description: "Never pair the same two people twice",
    people1: ["Alice"],
    people2: ["Bob"],
    shiftTypes: ["E"],
    date: ["WEEKDAY"],
    weight: Infinity,
  },
  "a3",
);

// `buildAffinityCard` always emits ONE term, so it cannot produce an advanced card;
// this shape (two top-level terms) is hand-built to exercise the read-only branch.
const ADVANCED: AffinityCard = {
  uid: "a4",
  description: "Advanced (multi-term) affinity",
  people1: [["Alice"], ["Bob"]],
  people2: ["Bob"],
  shiftTypes: ["D"],
  date: ["ALL"],
  weight: 5,
};

const CARDS: AffinityCard[] = [ENCOURAGE, DISABLED, HARD, ADVANCED];

const meta = {
  title: "Affinities/AffinityCardList",
  component: AffinityCardList,
  parameters: { layout: "padded" },
  args: {
    affinities: CARDS,
    onEdit: fn(),
    onDuplicate: fn(),
    onDelete: fn(),
    onSetDisabled: fn(),
    onReorder: fn(),
  },
} satisfies Meta<typeof AffinityCardList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("affinity-edit-0"));
    await expect(args.onEdit).toHaveBeenCalledWith("a1");

    await userEvent.click(canvas.getByTestId("affinity-dup-0"));
    await expect(args.onDuplicate).toHaveBeenCalledWith("a1");

    await userEvent.click(canvas.getByTestId("affinity-delete-0"));
    await expect(args.onDelete).toHaveBeenCalledWith("a1");

    // Card 0 is enabled, so the toggle asks for `true`.
    await userEvent.click(canvas.getByTestId("affinity-disable-0"));
    await expect(args.onSetDisabled).toHaveBeenCalledWith("a1", true);

    // "Up" on card 1 moves it before card 0.
    await userEvent.click(canvas.getByTestId("affinity-up-1"));
    await expect(args.onReorder).toHaveBeenCalledWith("a2", "a1", "before");
  },
};

export const Empty: Story = {
  args: { affinities: [] },
  play: async ({ canvas }) => {
    // The zero-data copy belongs to the editor shell (AffinitiesEditor); this list
    // simply renders no cards.
    await expect(canvas.getByTestId("affinities-list").children).toHaveLength(0);
  },
};

export const LongText: Story = {
  decorators: [withNarrowFrame],
  args: {
    affinities: [
      buildAffinityCard(
        {
          ...emptyAffinityForm(),
          description: LONG_PROSE,
          people1: [LONG_TOKEN],
          people2: ["Bob"],
          shiftTypes: ["D"],
          date: ["ALL"],
          weight: 5,
        },
        "lt",
      ),
    ],
  },
  play: async ({ canvas }) => {
    // The description is prose and must wrap without overflowing the frame.
    await expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"));
    await expect(canvas.getByTitle(LONG_TOKEN)).toBeVisible();
  },
};

// Last on purpose: the next light story would prove the theme reset.
export const Dark: Story = {
  globals: { theme: "dark" },
};
