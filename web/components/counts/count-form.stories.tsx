import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn } from "storybook/test";
import {
  LONG_TOKEN,
  expectNoHorizontalOverflow,
  withNarrowFrame,
} from "../../.storybook/story-helpers";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import { CountForm } from "./count-form";
import {
  buildCountCard,
  buildCountShiftTypeDomain,
  countToForm,
  emptyCountForm,
  type CountFormState,
} from "./counts-model";

const STATE = makeValidUiState();
const DOMAIN = buildCountShiftTypeDomain(STATE);

const VALID_FORM: CountFormState = {
  description: "Working shifts close to the average",
  person: ["Alice"],
  countDates: ["ALL"],
  countShiftTypes: ["N"],
  countShiftTypeCoefficients: [["N", 2]],
  expression: "x >= T",
  target: 5,
  weight: -1,
};

const meta = {
  title: "Counts/CountForm",
  component: CountForm,
  parameters: { layout: "padded" },
  args: {
    state: STATE,
    mode: "add",
    initialForm: VALID_FORM,
    onSave: fn(),
    onCancel: fn(),
  },
} satisfies Meta<typeof CountForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Add: Story = {
  play: async ({ args, canvas, userEvent }) => {
    // A valid draft: submit hands the whole form back to the editor.
    await userEvent.click(canvas.getByTestId("card-editor-submit"));
    await expect(args.onSave).toHaveBeenCalledWith(VALID_FORM);
  },
};

export const Edit: Story = {
  args: {
    mode: "edit",
    initialForm: countToForm(buildCountCard(VALID_FORM, DOMAIN, "c1"), DOMAIN),
  },
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByTestId("card-editor-form")).toHaveTextContent("Edit shift count");
    await userEvent.click(canvas.getByRole("button", { name: "Cancel" }));
    await expect(args.onCancel).toHaveBeenCalledOnce();
    await expect(args.onSave).not.toHaveBeenCalled();
  },
};

export const Invalid: Story = {
  // a11y violation tracked in nursing-sheduler-w0e.17; restore "error" when fixed.
  parameters: { a11y: { test: "todo" } },
  args: { initialForm: emptyCountForm() },
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("card-editor-submit"));
    // People, count dates and count shift types are all required; nothing is saved.
    await expect(canvas.getByText("At least one person must be selected")).toBeVisible();
    await expect(canvas.getByText("At least one date must be selected")).toBeVisible();
    await expect(canvas.getByText("At least one shift type must be selected")).toBeVisible();
    await expect(args.onSave).not.toHaveBeenCalled();
  },
};

export const LongText: Story = {
  decorators: [withNarrowFrame],
  args: { initialForm: { ...VALID_FORM, description: LONG_TOKEN, person: [LONG_TOKEN] } },
  play: async ({ canvas }) => {
    await expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"));
  },
};

export const Dark: Story = {
  // a11y violation tracked in nursing-sheduler-w0e.18; restore "error" when fixed.
  parameters: { a11y: { test: "todo" } },
  globals: { theme: "dark" },
};
