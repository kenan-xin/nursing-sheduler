import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, waitFor } from "storybook/test";
import "./calendar.css";
import { clickCalendarDay } from "../../.storybook/story-helpers";
import { MonthCalendar } from "./month-calendar";

// FullCalendar builds its grid imperatively after mount: every play waits for a known cell.
const cell = (root: HTMLElement, iso: string) =>
  root.querySelector<HTMLElement>(`[data-ns-date="${iso}"]`);

async function gridReady(root: HTMLElement, iso = "2026-07-06"): Promise<HTMLElement> {
  await waitFor(() => expect(cell(root, iso)).not.toBeNull());
  return cell(root, iso)!;
}

const meta = {
  title: "Dates/MonthCalendar",
  component: MonthCalendar,
  parameters: { layout: "padded" },
  args: { monthIso: "2026-07-01", onDayClick: fn(), ariaLabel: "July 2026" },
} satisfies Meta<typeof MonthCalendar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Display: Story = {
  play: async ({ canvasElement }) => {
    await gridReady(canvasElement);
    // The display variant renders adjacent-month days (Monday-first: 29 June leads).
    await expect(cell(canvasElement, "2026-06-29")).not.toBeNull();
  },
};

export const Picker: Story = {
  args: { variant: "picker" },
  play: async ({ args, canvasElement }) => {
    await clickCalendarDay(canvasElement, "2026-07-15");
    // FullCalendar fires dateClick after its (asynchronous) drag end.
    await waitFor(() => expect(args.onDayClick).toHaveBeenCalledOnce());
    await expect(args.onDayClick).toHaveBeenCalledWith("2026-07-15");
  },
};

export const WithDayContent: Story = {
  args: {
    dayContent: (info) => (
      <>
        <span>{info.dayText}</span>
        {info.iso === "2026-07-06" ? <span className="font-mono">late+</span> : null}
      </>
    ),
  },
  play: async ({ canvasElement }) => {
    const sixth = await gridReady(canvasElement);
    await expect(sixth).toHaveTextContent("late+");
  },
};

export const WithTitles: Story = {
  args: { dayTitle: (info) => (info.iso === "2026-07-06" ? "Ward audit" : undefined) },
  play: async ({ canvasElement }) => {
    const sixth = await gridReady(canvasElement);
    await expect(sixth).toHaveAttribute("title", "Ward audit");
    await expect(sixth).toHaveAttribute("aria-label", "Ward audit");
  },
};

export const CustomLabel: Story = {
  args: { ariaLabel: "Bank holiday picker" },
  play: async ({ canvas, canvasElement }) => {
    await gridReady(canvasElement);
    await expect(canvas.getByRole("group", { name: "Bank holiday picker" })).toBeVisible();
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await gridReady(canvasElement);
  },
};
