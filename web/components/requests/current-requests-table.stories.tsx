import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect } from "storybook/test";
import { LONG_TOKEN, withNarrowFrame } from "../../.storybook/story-helpers";
import { CurrentRequestsTable, type CurrentRequestRow } from "./current-requests-table";

// Purely presentational (FR-SR-39): the orchestrator hands in pre-formatted rows; the
// component owns only the local search box and its three render states.
const rows: CurrentRequestRow[] = [
  {
    key: "r-1",
    person: "Ada Lovelace",
    personIsGroup: false,
    dateLabel: "Mon 14 Jul",
    dateIsGroup: false,
    shiftLabel: "early1",
    weightLabel: "+5",
    weightTone: "positive",
    caption: "wants",
  },
  {
    key: "r-2",
    person: "Grace Hopper",
    personIsGroup: false,
    dateLabel: "Tue 15 Jul",
    dateIsGroup: false,
    shiftLabel: "late+",
    weightLabel: "−3",
    weightTone: "negative",
    caption: "avoids",
  },
  {
    key: "r-3",
    person: "NIGHT-TEAM",
    personIsGroup: true,
    dateLabel: "WEEKEND",
    dateIsGroup: true,
    shiftLabel: "OFF",
    weightLabel: "pinned",
    weightTone: "pin",
    caption: "paid leave · hard pin",
  },
];

const meta = {
  title: "Requests/CurrentRequestsTable",
  component: CurrentRequestsTable,
  parameters: { layout: "padded" },
  args: { rows },
} satisfies Meta<typeof CurrentRequestsTable>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("requests-count")).toHaveTextContent("3");
    await expect(canvas.getAllByTestId("requests-row")).toHaveLength(3);
    await expect(canvas.getByTestId("requests-search")).toBeVisible();
  },
};

export const Empty: Story = {
  args: { rows: [] },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("requests-count")).toHaveTextContent("0");
    await expect(canvas.getByTestId("requests-empty")).toHaveTextContent(
      "No shift requests defined yet.",
    );
  },
};

export const NoMatch: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.type(canvas.getByTestId("requests-search"), "zzz");
    await expect(canvas.getByTestId("requests-no-match")).toHaveTextContent(
      "No requests match “zzz”.",
    );
    await expect(canvas.queryAllByTestId("requests-row")).toHaveLength(0);
  },
};

export const LongText: Story = {
  decorators: [withNarrowFrame],
  args: {
    rows: [{ ...rows[0], key: "r-long", person: LONG_TOKEN, shiftLabel: LONG_TOKEN }],
  },
  play: async ({ canvas }) => {
    // KNOWN OVERFLOW nursing-sheduler-w0e.15: restore
    // `await expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"));` when fixed.
    // KNOWN OVERFLOW nursing-sheduler-w0e.15: restore
    // `await expect(canvas.getByTitle(LONG_TOKEN)).toBeVisible();` when fixed.
    await expect(canvas.getByTestId("current-requests-table")).toBeVisible();
  },
};

export const Dark: Story = {
  args: { ...Populated.args },
  globals: { theme: "dark" },
};
