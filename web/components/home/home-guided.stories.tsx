import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn } from "storybook/test";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import { pickScenario } from "@/lib/store";
import type { ScenarioSeed } from "../../.storybook/harness";
import { HomeGuided } from "./home-guided";
import { useScenarioSummary } from "./scenario-summary";

// HomeGuided takes the summary as a prop; derive it from the seeded store exactly as
// HomeScreen does. The Generate-DONE state needs the roster capture gate to commit a
// real run, so it is not storied here.
function Connected({ onNavigate }: { onNavigate: (path: string) => void }) {
  return <HomeGuided summary={useScenarioSummary()} onNavigate={onNavigate} />;
}

const VALID: ScenarioSeed = pickScenario(makeValidUiState());
const SETUP = ["/dates", "/people", "/shift-types", "/rules", "/shift-requests"];

const meta = {
  title: "Home/HomeGuided",
  component: HomeGuided,
  parameters: { scenario: "empty", layout: "padded" },
  // `summary` is required by the type only: `render` derives it from the store.
  args: { onNavigate: fn(), summary: undefined as never },
  render: ({ onNavigate }) => <Connected onNavigate={onNavigate} />,
} satisfies Meta<typeof HomeGuided>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NothingReady: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByTestId("home-progress")).toHaveTextContent("0 of 6 steps ready");
    await expect(canvas.getByTestId("home-card-/dates")).toHaveAttribute("data-status", "current");
    for (const path of [...SETUP.slice(1), "/optimize-and-export"]) {
      await expect(canvas.getByTestId(`home-card-${path}`)).toHaveAttribute("data-status", "todo");
    }
    await userEvent.click(canvas.getByTestId("home-cta-/dates"));
    await expect(args.onNavigate).toHaveBeenCalledWith("/dates");
  },
};

export const DatesDone: Story = {
  parameters: { scenario: { rangeStart: "2026-02-01", rangeEnd: "2026-02-28" } },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("home-card-/dates")).toHaveAttribute("data-status", "done");
    await expect(canvas.getByTestId("home-card-/people")).toHaveAttribute("data-status", "current");
    await expect(canvas.getByTestId("home-card-/rules")).toHaveAttribute("data-status", "todo");
  },
};

export const SetupComplete: Story = {
  parameters: { scenario: VALID },
  play: async ({ args, canvas, userEvent }) => {
    for (const path of SETUP) {
      await expect(canvas.getByTestId(`home-card-${path}`)).toHaveAttribute("data-status", "done");
    }
    await expect(canvas.getByTestId("home-progress")).toHaveTextContent("5 of 6 steps ready");
    const generate = canvas.getByTestId("home-card-/optimize-and-export");
    await expect(generate).toHaveAttribute("data-status", "current");
    await expect(generate).toHaveTextContent("Ready to generate");
    await userEvent.click(canvas.getByTestId("home-cta-/optimize-and-export"));
    await expect(args.onNavigate).toHaveBeenCalledWith("/optimize-and-export");
  },
};

export const Dark: Story = {
  parameters: { scenario: VALID },
  globals: { theme: "dark" },
};
