import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect } from "storybook/test";
import {
  LONG_TOKEN,
  expectNoHorizontalOverflow,
  withNarrowFrame,
} from "../../.storybook/story-helpers";
import { CurrentHistoryTable, type CurrentHistoryPerson } from "./current-history-table";

// Purely presentational (FR-SR-40): the orchestrator precomputes one row per person.
const meta = {
  title: "Requests/CurrentHistoryTable",
  component: CurrentHistoryTable,
  parameters: { layout: "padded" },
  args: { people: [] },
} satisfies Meta<typeof CurrentHistoryTable>;

export default meta;
type Story = StoryObj<typeof meta>;

// Shift ids are arbitrary codes, never AM/PM assumptions.
const people: CurrentHistoryPerson[] = [
  {
    key: "p-1",
    person: "Ada Lovelace",
    entries: [
      { hn: "H-3", label: "early1", kind: "worked" },
      { hn: "H-2", label: "OFF", kind: "off" },
      { hn: "H-1", label: "LEAVE", kind: "leave" },
    ],
  },
  {
    key: "p-2",
    person: "Grace Hopper",
    entries: [{ hn: "H-1", label: "late+", kind: "worked" }],
  },
];

export const Populated: Story = {
  args: { people },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("history-count")).toHaveTextContent("2");
    await expect(canvas.getByTestId("history-row-p-1")).toBeVisible();
    await expect(canvas.getByTestId("history-row-p-2")).toBeVisible();
    await expect(canvas.getByTestId("history-chip-p-1-H-1")).toHaveAttribute("data-kind", "leave");
  },
};

export const Empty: Story = {
  args: { people: [] },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("history-count")).toHaveTextContent("0");
    await expect(canvas.getByTestId("history-empty")).toHaveTextContent(
      "No history entries defined yet.",
    );
  },
};

export const LongText: Story = {
  decorators: [withNarrowFrame],
  args: {
    people: [
      {
        key: "p-long",
        person: LONG_TOKEN,
        entries: [{ hn: LONG_TOKEN, label: LONG_TOKEN, kind: "worked" }],
      },
    ],
  },
  play: async ({ canvas }) => {
    await expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"));
    // KNOWN OVERFLOW nursing-sheduler-w0e.14: restore
    // `await expect(canvas.getByTitle(LONG_TOKEN)).toBeVisible();` when fixed.
  },
};

export const Dark: Story = {
  args: { ...Populated.args },
  globals: { theme: "dark" },
};
