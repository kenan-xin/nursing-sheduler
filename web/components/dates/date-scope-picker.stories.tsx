import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, waitFor } from "storybook/test";
import type { DateRange } from "@/lib/dates";
import "./calendar.css";
import { clickCalendarDay } from "../../.storybook/story-helpers";
import { DateScopePicker } from "./date-scope-picker";

const FORTNIGHT: DateRange = { start: "2026-07-01", end: "2026-07-14" };

/** The fortnight's days split by UTC weekday, computed rather than hand-typed. */
function fortnight(weekend: boolean): string[] {
  const days: string[] = [];
  for (let d = Date.UTC(2026, 6, 1); d <= Date.UTC(2026, 6, 14); d += 86_400_000) {
    const day = new Date(d).getUTCDay();
    if ((day === 0 || day === 6) === weekend) days.push(new Date(d).toISOString().slice(0, 10));
  }
  return days;
}

const meta = {
  title: "Dates/DateScopePicker",
  component: DateScopePicker,
  parameters: { layout: "padded" },
  args: {
    range: FORTNIGHT,
    selected: new Set<string>(),
    onChange: fn(),
    testId: "scope",
    label: "Dates",
  },
} satisfies Meta<typeof DateScopePicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    await expect(canvas.getByTestId("scope-count")).toHaveTextContent("0 SELECTED");
    await userEvent.click(canvas.getByTestId("scope-weekdays"));
    await expect(args.onChange).toHaveBeenLastCalledWith(fortnight(false));
    await expect(fortnight(false)).toHaveLength(10);
    await userEvent.click(canvas.getByTestId("scope-weekends"));
    await expect(args.onChange).toHaveBeenLastCalledWith(fortnight(true));
    await clickCalendarDay(canvasElement, "2026-07-08");
    await waitFor(() => expect(args.onChange).toHaveBeenLastCalledWith(["2026-07-08"]));
  },
};

export const WithSelection: Story = {
  args: { selected: new Set(["2026-07-01", "2026-07-02", "2026-07-03"]) },
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByTestId("scope-count")).toHaveTextContent("3 SELECTED");
    await userEvent.click(canvas.getByTestId("scope-clear"));
    await expect(args.onChange).toHaveBeenCalledWith([]);
  },
};

export const Dark: Story = {
  args: { ...WithSelection.args },
  globals: { theme: "dark" },
};
