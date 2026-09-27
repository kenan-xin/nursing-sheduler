import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn } from "storybook/test";
import { deriveDateGroups, generateDateItems } from "@/lib/dates";
import {
  expectNoHorizontalOverflow,
  LONG_TOKEN,
  withNarrowFrame,
} from "../../.storybook/story-helpers";
import { DateScopeField, type DateScopeItem, type DateScopeOption } from "./date-scope-field";

// Auto-derived scope chips come from the repo's own group derivation; the
// specific-dates items are full-ISO refs (the field's grammar keys on ISO).
const AUTO_SCOPES: DateScopeOption[] = deriveDateGroups(
  generateDateItems({ start: "2026-05-14", end: "2026-05-20" }),
)
  .filter((g) => g.members.length > 0)
  .map((g) => ({ id: g.id, label: g.description }));

const DATE_ITEMS: DateScopeItem[] = ["2026-05-14", "2026-05-15", "2026-05-16", "2026-05-17"].map(
  (id) => ({ id, dayOfMonth: Number(id.slice(8)) }),
);

const DATE_GROUPS: DateScopeOption[] = [
  { id: "FirstTwo", label: "FirstTwo — first two days" },
  { id: "HolidayWk", label: "HolidayWk — holiday week" },
];

const meta = {
  title: "CardEditor/DateScopeField",
  component: DateScopeField,
  args: {
    autoScopes: AUTO_SCOPES,
    dateGroups: DATE_GROUPS,
    dateItems: DATE_ITEMS,
    value: [],
    onChange: fn(),
  },
} satisfies Meta<typeof DateScopeField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllDates: Story = {
  play: async ({ args, canvas, userEvent }) => {
    // Empty value ⇒ the ALL chip is lit, and choosing a scope emits its ref.
    await expect(canvas.getByRole("button", { name: /All dates/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(canvas.getByRole("button", { name: /All weekdays/ }));
    await expect(args.onChange).toHaveBeenCalledWith(["WEEKDAY"]);
  },
};

export const AutoScope: Story = {
  args: { value: ["WEEKDAY"] },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: /All weekdays/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  },
};

export const DateGroup: Story = {
  args: { value: ["FirstTwo"] },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: /FirstTwo — first two days/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  },
};

export const Custom: Story = {
  args: { value: ["2026-05-15", "2026-05-16"] },
  play: async ({ canvas }) => {
    // Concrete refs show as the specific-dates text, with no scope chip lit.
    await expect(canvas.getByTestId("date-scope-custom")).toHaveValue("15–16");
  },
};

export const LongText: Story = {
  decorators: [withNarrowFrame],
  args: {
    dateGroups: [{ id: "LongGroup", label: LONG_TOKEN }],
    value: ["LongGroup"],
  },
  play: async ({ canvas }) => {
    await expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"));
    await expect(canvas.getByTitle(LONG_TOKEN)).toBeVisible();
  },
};

// Last on purpose: the next light story would prove the theme reset.
export const Dark: Story = {
  args: { ...DateGroup.args },
  globals: { theme: "dark" },
};
