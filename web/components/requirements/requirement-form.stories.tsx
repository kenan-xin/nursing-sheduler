import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn } from "storybook/test";
import { createEmptyScenarioUiState, type ScenarioUiState } from "@/lib/scenario";
import {
  LONG_TOKEN,
  expectNoHorizontalOverflow,
  withNarrowFrame,
} from "../../.storybook/story-helpers";
import { RequirementForm } from "./requirement-form";
import {
  REQUIREMENT_MESSAGES,
  emptyRequirementForm,
  type RequirementFormState,
} from "./requirements-model";

// State and draft mirror requirement-form.skill-mix.test.tsx.
const STATE: ScenarioUiState = {
  ...createEmptyScenarioUiState(),
  rangeStart: "2026-07-01",
  rangeEnd: "2026-07-07",
  shifts: [
    { id: "early1", description: "Early" },
    { id: "N12", description: "Night" },
  ],
  staff: [{ id: "rn1" }, { id: "rn2" }, { id: "en1" }],
  staffGroups: [{ id: "RN", members: ["rn1", "rn2"] }],
};

const INITIAL: RequirementFormState = {
  ...emptyRequirementForm(),
  shiftType: ["N12"],
  requiredNumPeople: 4,
  qualifiedPeople: ["ALL"],
  date: ["ALL"],
};

const meta = {
  title: "Requirements/RequirementForm",
  component: RequirementForm,
  parameters: { layout: "padded" },
  args: { state: STATE, mode: "add", initialForm: INITIAL, onSave: fn(), onCancel: fn() },
} satisfies Meta<typeof RequirementForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Add: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.type(canvas.getByTestId("requirement-desc"), "Night cover");
    const required = canvas.getByTestId("requirement-required");
    await userEvent.clear(required);
    await userEvent.type(required, "3");
    await userEvent.type(canvas.getByTestId("requirement-preferred"), "3");
    await userEvent.click(canvas.getByRole("button", { name: "Add" }));
    await expect(args.onSave).toHaveBeenCalledOnce();
    await expect(args.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Night cover", requiredNumPeople: 3 }),
    );
  },
};

export const Edit: Story = {
  args: { mode: "edit", initialForm: { ...INITIAL, description: "Night cover" } },
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Update" }));
    await expect(args.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Night cover" }),
    );
    await userEvent.click(canvas.getByRole("button", { name: "Cancel" }));
    await expect(args.onCancel).toHaveBeenCalledOnce();
  },
};

export const SkillMix: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Add skill mix" }));
    const min = canvas.getByLabelText("Skill mix 1 minimum");
    await userEvent.clear(min);
    await userEvent.type(min, "2");
    await userEvent.selectOptions(canvas.getByLabelText("Skill mix 1 group"), "RN");
    await userEvent.click(canvas.getByRole("button", { name: "Add" }));
    await expect(args.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ skillMix: [{ people: "RN", minNumPeople: 2 }] }),
    );
  },
};

export const Invalid: Story = {
  args: {
    mode: "edit",
    initialForm: { ...INITIAL, skillMix: [{ people: "RN", minNumPeople: 5 }] },
  },
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Update" }));
    await expect(args.onSave).not.toHaveBeenCalled();
    await expect(canvas.getByText(REQUIREMENT_MESSAGES.skillMixAboveRequired)).toBeVisible();
  },
};

export const LongText: Story = {
  args: { mode: "edit", initialForm: { ...INITIAL, description: LONG_TOKEN } },
  decorators: [withNarrowFrame],
  play: async ({ canvas }) => {
    await expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"));
  },
};

export const Dark: Story = {
  args: {
    mode: "edit",
    initialForm: { ...INITIAL, skillMix: [{ people: "RN", minNumPeople: 2 }] },
  },
  globals: { theme: "dark" },
};
