import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, waitFor } from "storybook/test";
import type { ScenarioUiState } from "@/lib/scenario";
import { drainScenarioCommands, useScenarioStore } from "@/lib/store";
import { withToaster } from "../../.storybook/harness";
import { LONG_TOKEN, expectNoHorizontalOverflow } from "../../.storybook/story-helpers";
import { TemporaryCoverSection } from "./temporary-cover-section";

// Zero-prop section: shifts, groups and requirements come from the seeded scenario
// (temporary-cover-section.test.tsx `coverState`). No working roster is ever seeded
// here (the roster-storage single-writer rule), so the "run Optimize" callout is out of scope.
const SEED: Partial<ScenarioUiState> = {
  staff: [{ id: "Aisha", history: [] }],
  staffGroups: [{ id: "RN", members: ["Aisha"] }],
  shifts: [
    { id: "early1", description: "Early" },
    { id: "N12", description: "Night" },
  ],
  rangeStart: "2026-07-06",
  rangeEnd: "2026-07-12",
  cardsByKind: {
    requirements: [
      {
        uid: "r-all",
        description: "All nurses",
        shiftType: "N12",
        requiredNumPeople: 3,
        qualifiedPeople: "ALL",
        date: "ALL",
        weight: -1,
      },
    ],
    successions: [],
    counts: [],
    affinities: [],
    coverings: [],
  },
  temporaryCover: [],
};

const meta = {
  title: "People/TemporaryCoverSection",
  component: TemporaryCoverSection,
  decorators: [withToaster],
  parameters: {
    scenario: SEED,
    layout: "padded",
    nextjs: { appDirectory: true, navigation: { pathname: "/people" } },
  },
} satisfies Meta<typeof TemporaryCoverSection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  play: async ({ canvas, userEvent }) => {
    await expect(canvas.getByTestId("temporary-cover-empty")).toHaveTextContent(
      "No temporary cover",
    );
    await userEvent.click(canvas.getByTestId("temporary-cover-add"));
    await expect(canvas.getByTestId("temporary-cover-editor")).toBeVisible();
  },
};

export const AddCover: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("temporary-cover-add"));
    await userEvent.type(canvas.getByTestId("temporary-cover-name"), "Haseena (Ward 3)");
    // The date defaults to the range start (2026-07-06).
    await expect(canvas.getByTestId("temporary-cover-date")).toHaveValue("2026-07-06");
    await userEvent.selectOptions(canvas.getByTestId("temporary-cover-shift"), "N12");
    await userEvent.click(canvas.getByTestId("temporary-cover-save"));
    await waitFor(() =>
      expect(canvas.getByTestId("temporary-cover-table")).toHaveTextContent("Haseena (Ward 3)"),
    );
    await drainScenarioCommands();
    await expect(useScenarioStore.getState().temporaryCover).toHaveLength(1);
  },
};

// A second shift for the same name on the same date is refused.
export const Invalid: Story = {
  parameters: {
    scenario: {
      ...SEED,
      temporaryCover: [{ name: "Haseena", date: "2026-07-06", shiftType: "N12", groups: [] }],
    },
  },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("temporary-cover-add"));
    await userEvent.type(canvas.getByTestId("temporary-cover-name"), "Haseena");
    await userEvent.selectOptions(canvas.getByTestId("temporary-cover-shift"), "early1");
    await userEvent.click(canvas.getByTestId("temporary-cover-save"));
    await expect(canvas.getByTestId("temporary-cover-error")).toHaveTextContent("one shift a day");
    await drainScenarioCommands();
    await expect(useScenarioStore.getState().temporaryCover).toHaveLength(1);
  },
};

export const LongText: Story = {
  parameters: {
    scenario: {
      ...SEED,
      temporaryCover: [{ name: LONG_TOKEN, date: "2026-07-08", shiftType: "N12", groups: [] }],
    },
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("temporary-cover-table")).toHaveTextContent(LONG_TOKEN);
    await expectNoHorizontalOverflow(canvas.getByTestId("temporary-cover-section"));
  },
};

export const Dark: Story = {
  parameters: {
    scenario: {
      ...SEED,
      temporaryCover: [{ name: "Haseena", date: "2026-07-08", shiftType: "N12", groups: [] }],
    },
  },
  globals: { theme: "dark" },
};
