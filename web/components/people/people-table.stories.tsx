import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { getRouter } from "@storybook/nextjs-vite/navigation.mock";
import { expect, screen, waitFor } from "storybook/test";
import type { ScenarioUiState } from "@/lib/scenario";
import { drainScenarioCommands, useScenarioStore } from "@/lib/store";
import { withToaster } from "../../.storybook/harness";
import { LONG_TOKEN, expectNoHorizontalOverflow } from "../../.storybook/story-helpers";
import { PeopleTable } from "./people-table";

// Zero-prop screen: the staff list and groups come from the seeded scenario.
const SEED: Partial<ScenarioUiState> = {
  staff: [
    { id: "Aisha Rahman", history: [] },
    { id: "Bola Ade", history: [] },
    { id: "Chloe Wu", history: [] },
  ],
  staffGroups: [{ id: "Seniors", members: ["Aisha Rahman"] }],
};

const sk = (id: string) => `string:${id}`;

const meta = {
  title: "People/PeopleTable",
  component: PeopleTable,
  decorators: [withToaster],
  parameters: {
    scenario: SEED,
    layout: "fullscreen",
    nextjs: { appDirectory: true, navigation: { pathname: "/people" } },
  },
} satisfies Meta<typeof PeopleTable>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  parameters: { scenario: "empty" },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("people-empty")).toBeVisible();
    await expect(canvas.getByTestId("people-count")).toHaveTextContent("0 nurses");
  },
};

export const Populated: Story = {
  play: async ({ canvas, userEvent }) => {
    await expect(canvas.getByTestId("people-count")).toHaveTextContent("3 nurses");
    await expect(canvas.getByTestId(`people-groups-${sk("Aisha Rahman")}`)).toHaveTextContent(
      "Seniors",
    );
    await userEvent.type(canvas.getByTestId("people-search"), "bola");
    await expect(canvas.getByTestId("people-count")).toHaveTextContent("1 of 3 nurses match");
    await expect(canvas.queryByTestId(`people-row-${sk("Chloe Wu")}`)).toBeNull();
    await userEvent.click(canvas.getByTestId("people-search-clear"));
    await expect(canvas.getByTestId("people-count")).toHaveTextContent("3 nurses");
  },
};

export const NoMatch: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.type(canvas.getByTestId("people-search"), "zzz");
    await expect(canvas.getByTestId("people-empty")).toHaveTextContent("No matches");
    await userEvent.click(canvas.getByTestId("people-empty-clear"));
    await expect(canvas.getByTestId("people-count")).toHaveTextContent("3 nurses");
  },
};

export const AddPerson: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("people-add"));
    await userEvent.type(canvas.getByTestId("people-name-input-__new__"), "Dev Patel");
    await userEvent.click(canvas.getByTestId("people-save-__new__"));
    await waitFor(() => expect(canvas.getByTestId("people-count")).toHaveTextContent("4 nurses"));
    await drainScenarioCommands();
    await expect(useScenarioStore.getState().staff.map((p) => p.id)).toContain("Dev Patel");
  },
};

export const OpenUpload: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("people-upload"));
    const dialog = await screen.findByTestId("upload-dialog");
    await waitFor(() => expect(dialog).toBeVisible());
  },
};

export const Continue: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("people-continue"));
    await expect(getRouter().push).toHaveBeenCalledWith("/shift-types");
  },
};

// The name cell does not truncate; the table scrolls inside its own wrap instead.
export const LongText: Story = {
  parameters: { scenario: { staff: [{ id: LONG_TOKEN, history: [] }], staffGroups: [] } },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId(`people-name-${sk(LONG_TOKEN)}`)).toBeInTheDocument();
    await expectNoHorizontalOverflow(canvas.getByTestId("screen"));
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
