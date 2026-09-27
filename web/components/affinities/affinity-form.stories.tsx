import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn } from "storybook/test";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import {
  LONG_TOKEN,
  expectNoHorizontalOverflow,
  withNarrowFrame,
} from "../../.storybook/story-helpers";
import {
  buildAffinityCard,
  emptyAffinityForm,
  affinityToForm,
  type AffinitiesScenarioInput,
} from "./affinities-model";
import { AffinityForm } from "./affinity-form";

// The add/edit affinity form. Its `state` prop is the narrowed scenario slice the
// Affinities screen reads, taken from the repo's own valid-state builder.
const VALID = makeValidUiState();
const STATE: AffinitiesScenarioInput = {
  staff: VALID.staff,
  staffGroups: VALID.staffGroups,
  shifts: VALID.shifts,
  shiftGroups: VALID.shiftGroups,
  rangeStart: VALID.rangeStart,
  rangeEnd: VALID.rangeEnd,
  dateGroups: VALID.dateGroups,
};

const EXISTING = buildAffinityCard(
  {
    ...emptyAffinityForm(),
    description: "Encourage newcomers and seniors to work together",
    people1: ["Alice"],
    people2: ["Bob"],
    shiftTypes: ["D"],
    date: ["ALL"],
    weight: 10,
  },
  "a1",
);

const meta = {
  title: "Affinities/AffinityForm",
  component: AffinityForm,
  parameters: { layout: "padded" },
  args: {
    state: STATE,
    mode: "add",
    initialForm: emptyAffinityForm(),
    onSave: fn(),
    onCancel: fn(),
  },
} satisfies Meta<typeof AffinityForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Add: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.type(canvas.getByTestId("affinity-desc"), "Encourage teamwork");
    await userEvent.click(canvas.getByRole("button", { name: "Add Alice to people 1" }));
    await userEvent.click(canvas.getByRole("button", { name: "Add Bob to people 2" }));
    await userEvent.click(canvas.getByRole("button", { name: "Add D — Day to shift types" }));
    await userEvent.click(canvas.getByRole("button", { name: /All dates/ }));
    await userEvent.click(canvas.getByTestId("card-editor-submit"));
    await expect(args.onSave).toHaveBeenCalledWith({
      description: "Encourage teamwork",
      people1: ["Alice"],
      people2: ["Bob"],
      shiftTypes: ["D"],
      date: ["ALL"],
      weight: 1,
    });
  },
};

export const Edit: Story = {
  args: { mode: "edit", initialForm: affinityToForm(EXISTING) },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Edit affinity")).toBeVisible();
    await expect(canvas.getByTestId("affinity-desc")).toHaveValue(EXISTING.description);
  },
};

export const Invalid: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("card-editor-submit"));
    await expect(
      canvas.getByText("At least one person must be selected for People 1"),
    ).toBeVisible();
    await expect(args.onSave).not.toHaveBeenCalled();
  },
};

export const LongText: Story = {
  decorators: [withNarrowFrame],
  args: { state: { ...STATE, staff: [{ id: LONG_TOKEN }, { id: "Bob" }] } },
  play: async ({ canvas }) => {
    // The transfer-list row truncates the long staff name; nothing may overflow.
    await expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"));
  },
};

// Last on purpose: the next light story would prove the theme reset.
export const Dark: Story = {
  args: { ...Edit.args },
  globals: { theme: "dark" },
};
