import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, waitFor, within } from "storybook/test";
import "./calendar.css";
import type { DateRange } from "@/lib/dates";
import type { UiDateGroup } from "@/lib/scenario";
import {
  LONG_TOKEN,
  clickCalendarDay,
  expectNoHorizontalOverflow,
  withNarrowFrame,
} from "../../.storybook/story-helpers";
import { DateGroupsCard } from "./date-groups-card";

// Fixtures from date-groups-card.test.tsx: a single-month range, so member ids are `DD`.
const AUG: DateRange = { start: "2026-08-01", end: "2026-08-31" };
const GROUPS: UiDateGroup[] = [{ id: "SummerRun", members: ["01", "02", "03"] }];

const meta = {
  title: "Dates/DateGroupsCard",
  component: DateGroupsCard,
  parameters: { layout: "padded" },
  args: {
    range: AUG,
    editableGroups: GROUPS,
    onCreateGroup: fn(),
    onSaveGroup: fn(),
    onDeleteGroup: fn(),
  },
} satisfies Meta<typeof DateGroupsCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  args: { range: { start: "", end: "" }, editableGroups: [] },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("date-groups-empty")).toHaveTextContent(
      "Set a roster period above to create and preview date groups.",
    );
    await expect(canvas.getByTestId("date-group-add")).toBeDisabled();
  },
};

export const Populated: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("editable-group-SummerRun")).toBeVisible();
    await expect(canvas.getByTestId("editable-group-SummerRun-count")).toHaveTextContent("3 days");
    await expect(canvas.getByTestId("derived-groups")).toBeVisible();
  },
};

export const Create: Story = {
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    await userEvent.click(canvas.getByTestId("date-group-add"));
    const editor = canvas.getByTestId("date-group-editor-new");
    await userEvent.type(within(editor).getByTestId("date-group-name"), "BankHols");
    await clickCalendarDay(editor, "2026-08-10");
    await waitFor(() =>
      expect(within(editor).getByTestId("date-scope-picker-count")).toHaveTextContent("1 SELECTED"),
    );
    await clickCalendarDay(editor, "2026-08-11");
    await waitFor(() =>
      expect(within(editor).getByTestId("date-scope-picker-count")).toHaveTextContent("2 SELECTED"),
    );
    await userEvent.click(canvas.getByTestId("date-group-save"));
    await expect(args.onCreateGroup).toHaveBeenCalledOnce();
    await expect(args.onCreateGroup).toHaveBeenCalledWith("BankHols", ["10", "11"]);
    await expect(canvasElement.querySelector('[data-testid="date-group-editor-new"]')).toBeNull();
  },
};

export const DuplicateName: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("date-group-add"));
    await userEvent.type(canvas.getByTestId("date-group-name"), "SummerRun");
    await userEvent.click(canvas.getByTestId("date-group-save"));
    await expect(canvas.getByTestId("date-group-name-error")).toBeVisible();
    await expect(canvas.getByTestId("date-group-name")).toHaveAttribute("aria-invalid", "true");
    await expect(args.onCreateGroup).not.toHaveBeenCalled();
  },
};

export const EditAndDelete: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("editable-group-edit-SummerRun"));
    const name = canvas.getByTestId("date-group-name");
    await userEvent.clear(name);
    await userEvent.type(name, "SummerLong");
    await userEvent.click(canvas.getByTestId("date-group-save"));
    await expect(args.onSaveGroup).toHaveBeenCalledWith("SummerRun", "SummerLong", [
      "01",
      "02",
      "03",
    ]);
    await userEvent.click(canvas.getByTestId("editable-group-delete-SummerRun"));
    await expect(args.onDeleteGroup).toHaveBeenCalledWith("SummerRun");
  },
};

export const Preview: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("editable-group-preview-SummerRun"));
    await expect(canvas.getByTestId("date-group-preview")).toBeVisible();
    await expect(canvas.getByTestId("date-group-preview-count")).toHaveTextContent("3");
    await userEvent.click(canvas.getByTestId("date-group-preview-hide"));
    await expect(canvas.queryByTestId("date-group-preview")).toBeNull();
    await userEvent.click(canvas.getByTestId("editable-group-preview-SummerRun"));
    await userEvent.click(canvas.getByTestId("editable-group-preview-SummerRun"));
    await expect(canvas.getByTestId("date-group-preview")).toBeVisible();
    await userEvent.click(canvas.getByTestId("date-group-preview-clear"));
    await expect(canvas.queryByTestId("date-group-preview")).toBeNull();
  },
};

export const LongText: Story = {
  args: { editableGroups: [{ id: LONG_TOKEN, members: ["01"] }] },
  decorators: [withNarrowFrame],
  play: async ({ canvas }) => {
    await expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"));
    // The id is wrapped or truncated INSIDE the card, not clipped by it.
    const card = canvas.getByTestId(`editable-group-${LONG_TOKEN}`).getBoundingClientRect();
    const id = canvas.getByText(LONG_TOKEN).getBoundingClientRect();
    await expect(id.right).toBeLessThanOrEqual(card.right);
  },
};

export const Dark: Story = {
  args: { ...Populated.args },
  globals: { theme: "dark" },
};
