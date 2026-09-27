import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn } from "storybook/test";
import {
  LONG_TOKEN,
  expectNoHorizontalOverflow,
  withNarrowFrame,
} from "../../.storybook/story-helpers";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import { SuccessionForm } from "./succession-form";
import {
  buildSuccessionCard,
  emptySuccessionForm,
  successionToForm,
  type SuccessionFormState,
} from "./successions-model";

const STATE = makeValidUiState();

const VALID_FORM: SuccessionFormState = {
  description: "Forbid Evening → Day",
  person: ["Alice"],
  pattern: ["E", "D"],
  date: ["ALL"],
  weight: -5,
};

const meta = {
  title: "Successions/SuccessionForm",
  component: SuccessionForm,
  parameters: { layout: "padded" },
  args: {
    state: STATE,
    mode: "add",
    initialForm: VALID_FORM,
    onSave: fn(),
    onCancel: fn(),
  },
} satisfies Meta<typeof SuccessionForm>;

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
    initialForm: successionToForm(buildSuccessionCard(VALID_FORM, "s1")),
  },
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByTestId("card-editor-form")).toHaveTextContent("Edit succession");
    await userEvent.click(canvas.getByRole("button", { name: "Cancel" }));
    await expect(args.onCancel).toHaveBeenCalledOnce();
    await expect(args.onSave).not.toHaveBeenCalled();
  },
};

export const Invalid: Story = {
  // a11y violation tracked in nursing-sheduler-w0e.17; restore "error" when fixed.
  parameters: { a11y: { test: "todo" } },
  args: { initialForm: emptySuccessionForm() },
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("card-editor-submit"));
    // Person, pattern and dates are all required; nothing is saved.
    await expect(canvas.getByText("At least one person must be selected")).toBeVisible();
    await expect(
      canvas.getByText("At least 2 shift types must be selected for a succession pattern"),
    ).toBeVisible();
    await expect(canvas.getByText("At least one date must be selected")).toBeVisible();
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
  globals: { theme: "dark" },
};
