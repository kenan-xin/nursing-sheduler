import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, within } from "storybook/test";
import {
  LONG_TOKEN,
  expectNoHorizontalOverflow,
  withNarrowFrame,
} from "../../.storybook/story-helpers";
import { TransferList, type TransferOption } from "./transfer-list";

const PEOPLE: TransferOption<string>[] = [
  { value: "Aisha", label: "Aisha" },
  { value: "Ben", label: "Ben" },
  { value: "Chloe", label: "Chloe" },
  { value: "Dev", label: "Dev" },
];

const meta = {
  title: "EntityEditor/TransferList",
  component: TransferList<string>,
  parameters: { layout: "padded" },
  args: { idPrefix: "staff", items: PEOPLE, selected: [], onToggle: fn() },
} satisfies Meta<typeof TransferList<string>>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("transfer-selected-staff")).toHaveTextContent(
      "Nothing selected — pick from the left.",
    );
  },
};

export const Populated: Story = {
  args: { selected: ["Chloe", "Aisha"] },
  play: async ({ args, canvas, userEvent }) => {
    const chosen = canvas.getByTestId("transfer-selected-staff");
    const rows = within(chosen).getAllByRole("button", { name: /^Remove / });
    await expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "Remove Chloe",
      "Remove Aisha",
    ]);
    await userEvent.click(canvas.getByRole("button", { name: "Add Ben" }));
    await expect(args.onToggle).toHaveBeenCalledOnce();
    await expect(args.onToggle).toHaveBeenCalledWith("Ben");
    // Fully controlled: the pane does not move until `selected` changes.
    await expect(within(chosen).queryByText("Ben")).toBeNull();
  },
};

export const WithGroups: Story = {
  args: {
    groups: [{ value: "seniors", label: "seniors", isGroup: true }],
    selected: ["seniors"],
  },
  play: async ({ canvas }) => {
    const chosen = canvas.getByTestId("transfer-selected-staff");
    await expect(within(chosen).getByText("seniors")).toBeVisible();
    await expect(within(chosen).getByText("GROUPS")).toBeVisible();
  },
};

export const DisabledItem: Story = {
  // a11y violation tracked in nursing-sheduler-w0e.28; restore "error" when fixed
  parameters: { a11y: { test: "todo" } },
  args: {
    items: [
      ...PEOPLE,
      { value: "Eve", label: "Eve", disabled: true, disabledReason: "On leave all month" },
    ],
  },
  play: async ({ args, canvas, userEvent }) => {
    const eve = canvas.getByTitle("On leave all month");
    await expect(eve).toHaveTextContent("Eve");
    await userEvent.click(eve);
    await expect(args.onToggle).not.toHaveBeenCalled();
    // Add-all skips the disabled option.
    await userEvent.click(canvas.getByTestId("transfer-add-all-staff"));
    await expect(args.onToggle).toHaveBeenCalledTimes(PEOPLE.length);
    await expect(args.onToggle).not.toHaveBeenCalledWith("Eve");
  },
};

export const Search: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.type(canvas.getByTestId("transfer-search-staff"), "ch");
    const available = canvas.getByTestId("transfer-available-staff");
    await expect(within(available).getByText("Chloe")).toBeVisible();
    await expect(within(available).queryByText("Aisha")).toBeNull();
    await expect(canvas.getByTestId("transfer-add-all-staff")).toHaveTextContent(
      "Add all 1 matching",
    );
  },
};

export const AddAll: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("transfer-add-all-staff"));
    await expect(args.onToggle).toHaveBeenCalledTimes(PEOPLE.length);
    for (const person of PEOPLE) await expect(args.onToggle).toHaveBeenCalledWith(person.value);
  },
};

export const LongText: Story = {
  args: { items: [{ value: LONG_TOKEN, label: LONG_TOKEN }, ...PEOPLE], selected: [LONG_TOKEN] },
  decorators: [withNarrowFrame],
  play: async ({ canvas }) => {
    await expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"));
    const row = canvas.getByRole("button", { name: `Remove ${LONG_TOKEN}` });
    const text = within(row).getByText(LONG_TOKEN);
    await expect(text.scrollWidth).toBeGreaterThan(text.clientWidth);
  },
};

export const Dark: Story = {
  args: { ...Populated.args },
  globals: { theme: "dark" },
};
