import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect } from "storybook/test";
import { deriveCurrentDays, type RosterDocument } from "@/lib/roster";
import { fixtureRosterDocument } from "@/lib/roster/test-fixtures";
import {
  assignShiftRamp,
  buildAssignmentIndex,
  computeCoverage,
  computeRequirementGrid,
  deriveRequirementModel,
  type RequirementModel,
} from "@/lib/roster-viewer";
import type { ContainerWidth } from "./use-container-width";
import { RosterCoverage } from "./roster-coverage";

// Props derived from a real roster document with the same lib calls RosterViewer makes.
// The fixture leaves its one D requirement unstaffed on 2026-07-05.
function derive(document: RosterDocument, override?: Partial<RequirementModel>) {
  const { context } = document;
  const currentDays = deriveCurrentDays(document.solvedDays, document.edits);
  const model = {
    ...deriveRequirementModel(document.submission, {
      decrements: document.cover.decrements,
      live: [],
    }),
    ...override,
  };
  const assignments = buildAssignmentIndex(context, currentDays);
  return {
    context,
    ramp: assignShiftRamp(context.shiftTypes),
    coverage: computeCoverage(context, assignments, model),
    model,
    requirements: computeRequirementGrid(model, assignments, context.calendar.length),
  };
}

interface Args {
  width: ContainerWidth;
  model?: Partial<RequirementModel>;
}

const meta = {
  title: "RosterViewer/RosterCoverage",
  parameters: { layout: "padded" },
  loaders: [async () => ({ document: await fixtureRosterDocument() })],
  args: { width: { width: 1100, stacked: false } },
  render: ({ width, model }, { loaded }) => (
    <RosterCoverage {...derive(loaded.document as RosterDocument, model)} width={width} />
  ),
} satisfies Meta<Args>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Wide: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("roster-coverage-wide")).toBeVisible();
    await expect(canvas.getAllByTestId("roster-exact-shift-row").length).toBeGreaterThan(0);
  },
};

export const Stacked: Story = {
  args: { width: { width: 600, stacked: true } },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("roster-coverage-stacked")).toBeVisible();
    await expect(canvas.queryByTestId("roster-coverage-wide")).toBeNull();
  },
};

export const ModelUnavailable: Story = {
  args: { model: { equations: [], reason: "The submitted schedule could not be read." } },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("roster-coverage-model-unavailable")).toBeVisible();
  },
};

export const Mismatch: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getAllByTestId("roster-requirement-mismatch").length).toBeGreaterThan(0);
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
