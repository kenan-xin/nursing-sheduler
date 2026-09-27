import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect } from "storybook/test";
import type { RunLogEntry } from "@/lib/optimize";
import {
  LONG_PROSE,
  LONG_TOKEN,
  expectNoHorizontalOverflow,
  withNarrowFrame,
} from "../../.storybook/story-helpers";
import { RunEventLog } from "./run-event-log";

function entry(over: Partial<RunLogEntry>): RunLogEntry {
  return {
    seq: 1,
    kind: "lifecycle",
    label: "submitting",
    event: null,
    cursor: null,
    payload: null,
    detail: null,
    detailKind: null,
    elapsedSeconds: null,
    occurredAt: null,
    eventTime: null,
    ...over,
  };
}

const POPULATED: RunLogEntry[] = [
  entry({ seq: 1, kind: "lifecycle", label: "submit-started", detail: "submitting" }),
  entry({
    seq: 2,
    kind: "progress",
    label: "progress",
    detail: "score=42, elapsed=2s",
    detailKind: "expression",
  }),
  entry({
    seq: 3,
    kind: "result",
    label: "result-available",
    detail: "outcome=optimal, score=42",
    detailKind: "expression",
  }),
];

const meta = {
  title: "Optimize/RunEventLog",
  component: RunEventLog,
  parameters: { layout: "padded" },
  args: { log: [], active: false },
} satisfies Meta<typeof RunEventLog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByText("No optimisation events yet.")).toBeVisible();
    await expect(canvas.getByTestId("optimize-event-count")).toHaveTextContent("0");
  },
};

// A run still streaming: the log is open but has not received an event yet.
export const Active: Story = {
  args: { active: true },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Waiting for optimisation events…")).toBeVisible();
  },
};

export const Populated: Story = {
  // `active` keeps the collapsible open so the entries are actually rendered.
  args: { log: POPULATED, active: true },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("optimize-event-count")).toHaveTextContent("3");
    await expect(canvas.getByText("score=42, elapsed=2s")).toBeVisible();
  },
};

export const LongText: Story = {
  decorators: [withNarrowFrame],
  args: {
    active: true,
    log: [
      entry({
        seq: 1,
        kind: "error",
        label: LONG_TOKEN,
        detail: LONG_TOKEN,
        detailKind: "expression",
      }),
      entry({
        seq: 2,
        kind: "error",
        label: "stream-disconnected",
        detail: LONG_PROSE,
        detailKind: "prose",
      }),
    ],
  },
  play: async ({ canvas }) => {
    await expectNoHorizontalOverflow(canvas.getByTestId("optimize-event-log"));
  },
};

export const Dark: Story = {
  args: { ...Populated.args },
  globals: { theme: "dark" },
};
