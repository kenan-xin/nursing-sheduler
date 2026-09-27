import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, waitFor } from "storybook/test";
import type { DateRange } from "@/lib/dates";
import "./calendar.css";
import { clickCalendarDay } from "../../.storybook/story-helpers";
import { MonthGrids } from "./month-grids";

const JULY_AUGUST: DateRange = { start: "2026-07-20", end: "2026-08-10" };
const JULY_ONLY: DateRange = { start: "2026-07-06", end: "2026-07-19" };

const cell = (root: HTMLElement, iso: string) =>
  root.querySelector<HTMLElement>(`[data-ns-date="${iso}"]`);

async function cellReady(root: HTMLElement, iso: string): Promise<HTMLElement> {
  await waitFor(() => expect(cell(root, iso)).not.toBeNull());
  return cell(root, iso)!;
}

const meta = {
  title: "Dates/MonthGrids",
  component: MonthGrids,
  parameters: { layout: "padded" },
  args: { range: JULY_AUGUST, onDayClick: fn() },
} satisfies Meta<typeof MonthGrids>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SingleMonth: Story = {
  args: { range: JULY_ONLY },
  play: async ({ canvas, canvasElement }) => {
    await cellReady(canvasElement, "2026-07-06");
    // `monthLabels: "multi"` hides the heading for a single month.
    await expect(canvas.queryByTestId("month-label-2026-07-01")).toBeNull();
    await expect(canvas.getAllByRole("group")).toHaveLength(1);
  },
};

export const MultiMonth: Story = {
  args: { monthLabels: "multi" },
  play: async ({ canvas, canvasElement }) => {
    await cellReady(canvasElement, "2026-08-03");
    await expect(canvas.getByTestId("month-label-2026-07-01")).toHaveTextContent("July 2026");
    await expect(canvas.getByTestId("month-label-2026-08-01")).toHaveTextContent("August 2026");
    await expect(canvas.getAllByRole("group")).toHaveLength(2);
    await expect(canvas.getByRole("group", { name: "August 2026 (month 2 of 2)" })).toBeVisible();
  },
};

export const Picker: Story = {
  args: { variant: "picker" },
  play: async ({ args, canvasElement }) => {
    await clickCalendarDay(canvasElement, "2026-08-03");
    await waitFor(() => expect(args.onDayClick).toHaveBeenCalledOnce());
    await expect(args.onDayClick).toHaveBeenCalledWith("2026-08-03");
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await cellReady(canvasElement, "2026-08-03");
  },
};
