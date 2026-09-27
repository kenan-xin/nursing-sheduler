import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn } from "storybook/test";
import { assistantActions, useAssistantStore, type ChoiceOffer } from "@/lib/ai/assistant/store";
import { SENTINEL_KEY } from "@/lib/ai/assistant/test-support";
import {
  LONG_TOKEN,
  expectNoHorizontalOverflow,
  withFetchRoutes,
  withNarrowFrame,
} from "../../.storybook/story-helpers";
import { withAssistant } from "./assistant-story-harness.test-support";
import { ChoiceCard, describeAnswers } from "./choice-card";

// The option card behind `offer_choices`, seeded through the store the way
// choice-card.test.tsx does. A pick only calls `onSend`.
const SINGLE: ChoiceOffer = {
  question: "Who covers Sunday's late+?",
  options: [
    { label: "Ana Tan", detail: "Has 2 lates this week" },
    { label: "Ben Lee", detail: "Has 1 late this week" },
  ],
  multiple: false,
};

const PAGED: ChoiceOffer = {
  ...SINGLE,
  moreQuestions: [
    {
      question: "Which night shift?",
      options: [
        { label: "N12", detail: "20:00 to 08:00" },
        { label: "N8", detail: "22:00 to 06:00" },
      ],
      multiple: false,
    },
  ],
};

const show = (offer: ChoiceOffer) => () => {
  assistantActions.showChoices(offer, useAssistantStore.getState().turnEpoch);
};

const meta = {
  title: "AI/ChoiceCard",
  component: ChoiceCard,
  decorators: [
    (Story) => (
      <div className="w-96">
        <Story />
      </div>
    ),
  ],
  beforeEach: [withAssistant(), withFetchRoutes([])],
  args: { onSend: fn(), disabled: false },
} satisfies Meta<typeof ChoiceCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Single: Story = {
  beforeEach: show(SINGLE),
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByRole("group", { name: SINGLE.question })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: /Ana Tan/ }));
    await expect(args.onSend).toHaveBeenCalledOnce();
    await expect(args.onSend).toHaveBeenCalledWith("Ana Tan");
  },
};

export const MultiQuestion: Story = {
  beforeEach: show(PAGED),
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByText("1 of 2")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: /Ben Lee/ }));
    await expect(canvas.getByTestId("assistant-choices")).toHaveAttribute("data-page", "1");
    await userEvent.click(canvas.getByRole("button", { name: "Previous question" }));
    await expect(canvas.getByTestId("assistant-choices")).toHaveAttribute("data-page", "0");
    await userEvent.click(canvas.getByRole("button", { name: "Next question" }));
    await userEvent.click(canvas.getByRole("button", { name: /N12/ }));
    await expect(args.onSend).toHaveBeenCalledWith(
      describeAnswers([PAGED, ...PAGED.moreQuestions!], ["Ben Lee", "N12"]),
    );
  },
};

export const Skip: Story = {
  beforeEach: show(SINGLE),
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Skip" }));
    await expect(useAssistantStore.getState().activeChoices).toBeNull();
    await expect(args.onSend).not.toHaveBeenCalled();
  },
};

export const Disabled: Story = {
  args: { disabled: true },
  beforeEach: show(SINGLE),
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByRole("button", { name: /Ana Tan/ })).toBeDisabled();
    await userEvent.click(canvas.getByRole("button", { name: /Ana Tan/ }));
    await expect(args.onSend).not.toHaveBeenCalled();
  },
};

export const LongText: Story = {
  decorators: [withNarrowFrame],
  beforeEach: show({
    ...SINGLE,
    options: [{ label: LONG_TOKEN, detail: LONG_TOKEN }, ...SINGLE.options],
  }),
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("assistant-choices")).toHaveTextContent(LONG_TOKEN);
    await expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"));
  },
};

export const Dark: Story = {
  beforeEach: show(PAGED),
  globals: { theme: "dark" },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("assistant-choices")).toBeVisible();
    await expect(document.body.textContent).not.toContain(SENTINEL_KEY);
  },
};
