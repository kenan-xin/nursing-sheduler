import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { getRouter } from "@storybook/nextjs-vite/navigation.mock";
import { expect, waitFor, within } from "storybook/test";
import { useNavGuardStore } from "@/components/shell/nav-guard-store";
import { useModeStore } from "@/lib/mode/mode";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import { pickScenario, useScenarioStore } from "@/lib/store";
import type { ScenarioSeed } from "../../.storybook/harness";
import { HomeScreen } from "./home-screen";

const VALID: ScenarioSeed = pickScenario(makeValidUiState());

const meta = {
  title: "Home/HomeScreen",
  component: HomeScreen,
  parameters: {
    scenario: VALID,
    layout: "padded",
    nextjs: { appDirectory: true, navigation: { pathname: "/" } },
  },
} satisfies Meta<typeof HomeScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Guided: Story = {
  play: async ({ canvas, userEvent }) => {
    await expect(canvas.getByTestId("home-screen")).toHaveAttribute("data-mode", "guided");
    const nurses = within(canvas.getByTestId("home-stat-strip")).getByText("Nurses");
    await expect(nurses.parentElement).toHaveTextContent(
      String(useScenarioStore.getState().staff.length),
    );
    await userEvent.click(canvas.getByTestId("home-generate"));
    await expect(getRouter().push).toHaveBeenCalledWith("/optimize-and-export");
  },
};

export const Advanced: Story = {
  beforeEach: () => {
    useModeStore.setState({ mode: "advanced" });
  },
  play: async ({ canvas }) => {
    // The screen fades in (`animate-fade`).
    await waitFor(() => expect(canvas.getByTestId("home-advanced")).toBeVisible());
    await expect(canvas.queryByTestId("home-wizard-grid")).toBeNull();
    await expect(canvas.getByTestId("home-stat-strip")).toBeVisible();
  },
};

export const GuardedByDraft: Story = {
  beforeEach: () =>
    useNavGuardStore.getState().registerDraft({ id: "story-draft", label: "Unsaved card" }),
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("home-generate"));
    await expect(getRouter().push).not.toHaveBeenCalled();
    await expect(useNavGuardStore.getState().pendingIntent?.kind).toBe("push");
  },
};

export const EmptyScenario: Story = {
  parameters: { scenario: "empty" },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("Build Your Roster");
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
