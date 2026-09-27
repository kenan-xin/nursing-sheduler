import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect } from "storybook/test";
import {
  LONG_TOKEN,
  expectNoHorizontalOverflow,
  withNarrowFrame,
} from "../../.storybook/story-helpers";
import { ScenarioIssuesList } from "./scenario-issues-list";

const ONE_ISSUE = [{ path: "dates.range", message: "The end date is before the start date." }];

const meta = {
  title: "SaveLoad/ScenarioIssuesList",
  component: ScenarioIssuesList,
  parameters: { layout: "padded" },
  args: { issues: ONE_ISSUE },
} satisfies Meta<typeof ScenarioIssuesList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OneIssue: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("scenario-export-issues")).toHaveTextContent(
      "1 issue must be fixed before this scenario can be saved.",
    );
  },
};

export const ManyIssues: Story = {
  args: {
    issues: [
      { path: "dates.range", message: "The end date is before the start date." },
      { path: "people.items.0.id", message: "A person id is missing." },
      { path: "shiftTypes.items.1.durationMinutes", message: "Duration must be positive." },
    ],
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("scenario-export-issues")).toHaveTextContent(
      "3 issues must be fixed before this scenario can be saved.",
    );
    await expect(canvas.getAllByRole("listitem")).toHaveLength(3);
  },
};

export const CustomAction: Story = {
  args: { action: "this scenario can be exported" },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("scenario-export-issues")).toHaveTextContent(
      "1 issue must be fixed before this scenario can be exported.",
    );
  },
};

export const LongText: Story = {
  decorators: [withNarrowFrame],
  args: { issues: [{ path: LONG_TOKEN, message: LONG_TOKEN }] },
  play: async ({ canvas }) => {
    await expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"));
  },
};

export const Dark: Story = {
  args: { ...ManyIssues.args },
  globals: { theme: "dark" },
};
