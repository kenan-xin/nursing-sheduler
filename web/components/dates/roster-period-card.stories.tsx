import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fireEvent, fn } from "storybook/test";
import type { DateRange } from "@/lib/dates";
import { RosterPeriodCard } from "./roster-period-card";

const COMMITTED: DateRange = { start: "2026-08-01", end: "2026-08-31" };

const meta = {
  title: "Dates/RosterPeriodCard",
  component: RosterPeriodCard,
  parameters: { layout: "padded" },
  args: { range: COMMITTED, importedHolidaysPresent: false, onCommit: fn() },
} satisfies Meta<typeof RosterPeriodCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ args, canvas }) => {
    // An edit is a draft; Apply commits it with the effective import flag.
    fireEvent.change(canvas.getByTestId("range-end"), { target: { value: "2026-08-20" } });
    await expect(args.onCommit).not.toHaveBeenCalled();
    fireEvent.click(canvas.getByTestId("range-apply"));
    await expect(args.onCommit).toHaveBeenCalledWith(
      { start: "2026-08-01", end: "2026-08-20" },
      false,
    );
  },
};

export const InvalidRange: Story = {
  play: async ({ args, canvas }) => {
    fireEvent.change(canvas.getByTestId("range-end"), { target: { value: "2026-07-01" } });
    await expect(canvas.getByTestId("range-invalid")).toBeVisible();
    await expect(canvas.getByTestId("range-duration")).not.toHaveTextContent("day");
    await expect(args.onCommit).not.toHaveBeenCalled();
  },
};

export const HolidaysImported: Story = {
  args: { importedHolidaysPresent: true },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("import-toggle")).toHaveAttribute("aria-checked", "true");
    await expect(canvas.getByTestId("import-count")).toBeVisible();
  },
};

export const ImportToggleOn: Story = {
  args: { range: { start: "", end: "" }, importedHolidaysPresent: false },
  play: async ({ args, canvas }) => {
    // A fresh roster seeds the import ON; a valid range surfaces it and the commit
    // carries the flag.
    fireEvent.change(canvas.getByTestId("range-start"), { target: { value: "2026-08-01" } });
    fireEvent.change(canvas.getByTestId("range-end"), { target: { value: "2026-08-31" } });
    await expect(canvas.getByTestId("import-toggle")).toHaveAttribute("aria-checked", "true");
    await expect(args.onCommit).toHaveBeenLastCalledWith(
      { start: "2026-08-01", end: "2026-08-31" },
      true,
    );
  },
};

export const Dark: Story = {
  args: { ...HolidaysImported.args },
  globals: { theme: "dark" },
};
