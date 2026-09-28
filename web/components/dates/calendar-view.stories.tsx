import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, waitFor } from "storybook/test";
import "./calendar.css";
import { CalendarView } from "./calendar-view";

const cell = (root: HTMLElement, iso: string) =>
  root.querySelector<HTMLElement>(`[data-ns-date="${iso}"]`);

const meta = {
  title: "Dates/CalendarView",
  component: CalendarView,
  parameters: { layout: "padded" },
  args: { range: { start: "2026-07-20", end: "2026-08-10" } },
} satisfies Meta<typeof CalendarView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByTestId("calendar-view")).toBeVisible();
    await waitFor(() => expect(cell(canvasElement, "2026-07-20")).not.toBeNull());
    // The endpoints are labelled and titled; adjacent-month spillover never is.
    const start = cell(canvasElement, "2026-07-20")!;
    await expect(start).toHaveTextContent("START");
    await expect(start).toHaveAttribute("title", "Start of roster");
    await expect(cell(canvasElement, "2026-08-10")).toHaveTextContent("END");
  },
};

export const ThreeMonths: Story = {
  args: { range: { start: "2026-07-15", end: "2026-09-15" } },
  play: async ({ canvas, canvasElement }) => {
    await waitFor(() => expect(cell(canvasElement, "2026-09-15")).not.toBeNull());
    for (const month of ["2026-07-01", "2026-08-01", "2026-09-01"]) {
      await expect(canvas.getByTestId(`month-label-${month}`)).toBeVisible();
    }
    await expect(canvas.getAllByRole("group")).toHaveLength(3);
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(cell(canvasElement, "2026-07-20")).not.toBeNull());
  },
};
