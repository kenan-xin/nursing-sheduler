import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, screen, waitFor } from "storybook/test";
import { LONG_TOKEN, expectNoHorizontalOverflow } from "../../.storybook/story-helpers";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "./combobox";

// Fixture shift ids carry arbitrary shift codes, never AM/PM assumptions.
const SHIFT_IDS = ["early1", "late+", "N12", "night"];

// Portalled (Base UI Combobox popup): the popup is queried with `screen`, never
// `canvas`. The item labels are strings, so the selected value is the id itself.
const meta = {
  title: "UI/Combobox",
  component: Combobox,
  args: { items: SHIFT_IDS, onValueChange: fn() },
  render: (args) => (
    <Combobox items={args.items} onValueChange={args.onValueChange}>
      <ComboboxInput aria-label="Shift" placeholder="Search shifts" />
      <ComboboxContent>
        <ComboboxList>
          {SHIFT_IDS.map((id) => (
            <ComboboxItem key={id} value={id}>
              {id}
            </ComboboxItem>
          ))}
        </ComboboxList>
        <ComboboxEmpty>No shifts match that search.</ComboboxEmpty>
      </ComboboxContent>
    </Combobox>
  ),
} satisfies Meta<typeof Combobox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.type(canvas.getByRole("combobox", { name: "Shift" }), "ni");
    await userEvent.click(await screen.findByRole("option", { name: "night" }));
    await expect(args.onValueChange).toHaveBeenCalledWith("night", expect.anything());
  },
};

export const NoMatch: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.type(canvas.getByRole("combobox", { name: "Shift" }), "zzz");
    const empty = await screen.findByText("No shifts match that search.");
    await waitFor(() => expect(empty).toBeVisible());
  },
};

// The Combobox renders the option label itself, so it is one of the three `ui/*`
// primitives that gets a LongText story (Input, InfoTip, Combobox).
export const LongText: Story = {
  args: { items: [LONG_TOKEN], defaultOpen: true },
  render: () => (
    <Combobox items={[LONG_TOKEN]} defaultOpen onValueChange={fn()}>
      <ComboboxInput aria-label="Shift" placeholder="Search shifts" />
      <ComboboxContent>
        <ComboboxList>
          <ComboboxItem value={LONG_TOKEN}>{LONG_TOKEN}</ComboboxItem>
        </ComboboxList>
        <ComboboxEmpty>No shifts match that search.</ComboboxEmpty>
      </ComboboxContent>
    </Combobox>
  ),
  play: async () => {
    const popup = await screen.findByRole("listbox");
    await expectNoHorizontalOverflow(popup);
  },
};

// The open popup is the file's richest state, and its `--surface2` plane is the
// part of the component dark axe can only reach while it is open.
export const Dark: Story = {
  args: { defaultOpen: true },
  globals: { theme: "dark" },
};
