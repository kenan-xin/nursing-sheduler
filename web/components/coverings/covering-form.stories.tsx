import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn } from "storybook/test";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import {
  LONG_TOKEN,
  expectNoHorizontalOverflow,
  withNarrowFrame,
} from "../../.storybook/story-helpers";
import {
  buildCoveringCard,
  emptyCoveringForm,
  coveringToForm,
  type CoveringsScenarioInput,
} from "./coverings-model";
import { CoveringForm } from "./covering-form";

// The add/edit covering form. Its `state` prop is the narrowed scenario slice the
// Coverings screen reads, taken from the repo's own valid-state builder.
const VALID = makeValidUiState();
const STATE: CoveringsScenarioInput = {
  staff: VALID.staff,
  staffGroups: VALID.staffGroups,
  shifts: VALID.shifts,
  shiftGroups: VALID.shiftGroups,
  rangeStart: VALID.rangeStart,
  rangeEnd: VALID.rangeEnd,
  dateGroups: VALID.dateGroups,
};

const EXISTING = buildCoveringCard(
  {
    ...emptyCoveringForm(),
    description: "Every new starter on days is supervised",
    preceptors: ["Alice"],
    preceptees: ["Bob"],
    shiftTypes: ["D"],
    dates: ["ALL"],
  },
  "c1",
);

const meta = {
  title: "Coverings/CoveringForm",
  component: CoveringForm,
  parameters: { layout: "padded" },
  args: {
    state: STATE,
    mode: "add",
    initialForm: emptyCoveringForm(),
    onSave: fn(),
    onCancel: fn(),
  },
} satisfies Meta<typeof CoveringForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Add: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.type(canvas.getByTestId("covering-desc"), "Supervise new starters");
    await userEvent.click(canvas.getByRole("button", { name: "Add Alice as a preceptor" }));
    await userEvent.click(canvas.getByRole("button", { name: "Add Bob as a preceptee" }));
    await userEvent.click(
      canvas.getByRole("button", { name: "Add D — Day as a covered shift type" }),
    );
    await userEvent.click(canvas.getByTestId("card-editor-submit"));
    await expect(args.onSave).toHaveBeenCalledWith({
      description: "Supervise new starters",
      preceptors: ["Alice"],
      preceptees: ["Bob"],
      shiftTypes: ["D"],
      dates: [],
    });
  },
};

export const Edit: Story = {
  args: { mode: "edit", initialForm: coveringToForm(EXISTING) },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Edit covering")).toBeVisible();
    await expect(canvas.getByTestId("covering-desc")).toHaveValue(EXISTING.description);
  },
};

export const Invalid: Story = {
  // a11y violation tracked in nursing-sheduler-w0e.17; restore "error" when fixed
  parameters: { a11y: { test: "todo" } },
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("card-editor-submit"));
    await expect(canvas.getByText("At least one preceptor must be selected")).toBeVisible();
    await expect(args.onSave).not.toHaveBeenCalled();
  },
};

export const HardRuleNote: Story = {
  // a11y violation tracked in nursing-sheduler-w0e.17; restore "error" when fixed
  parameters: { a11y: { test: "todo" } },
  play: async ({ canvas }) => {
    // A covering is always a hard rule — the dial is replaced by the locked note.
    await expect(canvas.getByTestId("card-editor-hard-note")).toHaveTextContent(
      "always enforced as a hard rule",
    );
  },
};

export const LongText: Story = {
  // a11y violation tracked in nursing-sheduler-w0e.17; restore "error" when fixed
  parameters: { a11y: { test: "todo" } },
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
