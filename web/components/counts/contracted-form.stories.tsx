import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn } from "storybook/test";
import { createEmptyScenarioUiState, type ScenarioUiState } from "@/lib/scenario";
import {
  LONG_TOKEN,
  expectNoHorizontalOverflow,
  withNarrowFrame,
} from "../../.storybook/story-helpers";
import { ContractedForm } from "./contracted-form";
import {
  CONTRACTED_MESSAGES,
  emptyContractedForm,
  type ContractedFormState,
} from "./contracted-model";

// Fixtures copied from contracted-form.test.tsx.
const STATE: ScenarioUiState = {
  ...createEmptyScenarioUiState(),
  staff: [{ id: "Anna" }, { id: "Lil" }],
  shifts: [
    { id: "D", durationMinutes: 480 },
    { id: "N", durationMinutes: 600 },
  ],
  rangeStart: "2026-07-01",
  rangeEnd: "2026-07-31",
  reqData: [{ kind: "leave", person: "Anna", date: "2026-07-06" }],
};

function draft(overrides: Partial<ContractedFormState> = {}): ContractedFormState {
  return {
    ...emptyContractedForm(),
    person: ["ALL"],
    countDates: ["ALL"],
    countShiftTypes: ["D", "LEAVE"],
    countShiftTypeCoefficients: [
      ["D", 16],
      ["LEAVE", 16],
    ],
    targetExact: "160h",
    ...overrides,
  };
}

const meta = {
  title: "Counts/ContractedForm",
  component: ContractedForm,
  parameters: { layout: "padded" },
  args: {
    state: STATE,
    mode: "add",
    initialForm: draft(),
    isEnabled: true,
    onSave: fn(),
    onCancel: fn(),
  },
} satisfies Meta<typeof ContractedForm>;

export default meta;
type Story = StoryObj<typeof meta>;

const saved = (onSave: unknown) =>
  (onSave as ReturnType<typeof fn>).mock.calls[0]![0] as ContractedFormState;

export const Add: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByTestId("contracted-plain-english-sentence")).toHaveTextContent(
      "exactly 160h",
    );
    await userEvent.type(canvas.getByTestId("contracted-desc"), "Full-time contract");
    await userEvent.click(canvas.getByTestId("card-editor-submit"));
    await expect(args.onSave).toHaveBeenCalledOnce();
    await expect(saved(args.onSave).description).toBe("Full-time contract");
    await expect(saved(args.onSave).targetExact).toBe("160h");
  },
};

export const Edit: Story = {
  args: { mode: "edit", initialForm: draft({ description: "Part-time" }) },
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByText("Edit Contracted Hours")).toBeVisible();
    await expect(canvas.getByTestId("card-editor-submit")).toHaveTextContent("Update contract");
    await userEvent.click(canvas.getByRole("button", { name: "Cancel" }));
    await expect(args.onCancel).toHaveBeenCalledOnce();
  },
};

export const Invalid: Story = {
  args: { initialForm: draft({ policy: "range" }) },
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("card-editor-submit"));
    await expect(args.onSave).not.toHaveBeenCalled();
    await expect(canvas.getAllByText(CONTRACTED_MESSAGES.target)).toHaveLength(1);
  },
};

export const LockedWeight: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("contracted-locked-weight")).toHaveTextContent("+∞");
    await expect(canvas.getByTestId("contracted-solver-summary")).toHaveTextContent("x = 320 · +∞");
  },
};

// The draft does not credit LEAVE, so Anna's leave day is flagged.
export const LeaveAdvisory: Story = {
  args: {
    mode: "edit",
    initialForm: draft({ countShiftTypes: ["D"], countShiftTypeCoefficients: [["D", 16]] }),
  },
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByTestId("contracted-leave-advisory-text")).toHaveTextContent("Anna");
    await userEvent.click(canvas.getByTestId("contracted-add-leave"));
    await expect(canvas.queryByTestId("contracted-leave-advisory")).toBeNull();
    await expect(args.onSave).not.toHaveBeenCalled();
  },
};

export const RefreshPreview: Story = {
  args: {
    initialForm: draft({ countShiftTypes: ["D"], countShiftTypeCoefficients: [["D", ""]] }),
  },
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("contracted-refresh-button"));
    await expect(canvas.getByTestId("contracted-refresh-preview")).toHaveTextContent(
      "Shift Types changed",
    );
    for (const kind of ["added", "removed"]) {
      await expect(canvas.getByTestId(`contracted-refresh-count-${kind}`)).toBeVisible();
    }
    await userEvent.click(canvas.getByTestId("contracted-refresh-cancel"));
    await expect(canvas.queryByTestId("contracted-refresh-preview")).toBeNull();
    await userEvent.click(canvas.getByTestId("contracted-refresh-button"));
    await userEvent.click(canvas.getByTestId("contracted-refresh-confirm"));
    await userEvent.click(canvas.getByTestId("card-editor-submit"));
    await expect(saved(args.onSave).countShiftTypeCoefficients).toContainEqual(["D", 16]);
  },
};

export const LongText: Story = {
  args: { mode: "edit", initialForm: draft({ description: LONG_TOKEN }) },
  decorators: [withNarrowFrame],
  play: async ({ canvas }) => {
    await expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"));
  },
};

export const Dark: Story = {
  args: {
    mode: "edit",
    initialForm: draft({ countShiftTypes: ["D"], countShiftTypeCoefficients: [["D", 16]] }),
  },
  globals: { theme: "dark" },
};
