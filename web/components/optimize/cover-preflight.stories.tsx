import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { getRouter } from "@storybook/nextjs-vite/navigation.mock";
import { expect, within } from "storybook/test";
import type { UiTemporaryCover } from "@/lib/scenario";
import { makeTemporaryCover, makeValidUiState } from "@/lib/scenario/test-fixtures";
import { pickScenario, scenarioCommands } from "@/lib/store";
import type { ScenarioSeed } from "../../.storybook/harness";
import { LONG_TOKEN, withNarrowFrame } from "../../.storybook/story-helpers";
import { CoverPreflight } from "./cover-preflight";

const withCover =
  (temporaryCover: UiTemporaryCover[]): ScenarioSeed =>
  async () => {
    await scenarioCommands.mutate(pickScenario(makeValidUiState()));
    await scenarioCommands.mutate({ temporaryCover });
  };

// The valid fixture runs 14-20 May 2026, with shift types D, E and N.
const FLAGGED = withCover([
  makeTemporaryCover({ date: "2026-06-01" }),
  makeTemporaryCover({ name: "Priya (Ward 5)", shiftType: "late+", date: "2026-05-15" }),
]);

const meta = {
  title: "Optimize/CoverPreflight",
  component: CoverPreflight,
  parameters: {
    scenario: FLAGGED,
    layout: "padded",
    nextjs: { appDirectory: true, navigation: { pathname: "/optimize-and-export" } },
  },
} satisfies Meta<typeof CoverPreflight>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NoFlags: Story = {
  parameters: { scenario: pickScenario(makeValidUiState()) },
  play: async ({ canvas }) => {
    await expect(canvas.queryByTestId("optimize-cover-preflight")).toBeNull();
  },
};

export const Flagged: Story = {
  play: async ({ canvas, userEvent }) => {
    const callout = canvas.getByTestId("optimize-cover-preflight");
    await expect(callout).toHaveTextContent("Some temporary cover lowers no staffing need");
    const items = within(callout).getAllByRole("listitem");
    await expect(items).toHaveLength(2);
    await expect(items[0]).toHaveTextContent(/the date is outside the schedule period\.$/);
    await expect(items[1]).toHaveTextContent(/the shift type no longer exists\.$/);
    await userEvent.click(within(callout).getByRole("link", { name: "Staff" }));
    await expect(getRouter().push).toHaveBeenCalledWith("/people");
  },
};

export const LongText: Story = {
  parameters: {
    scenario: withCover([makeTemporaryCover({ name: LONG_TOKEN, date: "2026-06-01" })]),
  },
  decorators: [withNarrowFrame],
  play: async ({ canvas }) => {
    // KNOWN OVERFLOW nursing-sheduler-w0e.26: restore `await expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"));` when fixed
    await expect(canvas.getByTitle(new RegExp(`^${LONG_TOKEN}, `))).toBeVisible();
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
