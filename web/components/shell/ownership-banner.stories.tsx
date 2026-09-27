import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, screen, waitFor, within } from "storybook/test";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import { pickScenario, scenarioCommands, useAuthorityStore } from "@/lib/store";
import { installTestAuthority } from "@/lib/store/test-authority";
import { withToaster, type ScenarioSeed } from "../../.storybook/harness";
import { OwnershipBanner } from "./ownership-banner";

const VALID: ScenarioSeed = pickScenario(makeValidUiState());

// A real second tab seizes the lease; this tab learns on its next heartbeat, exactly as
// in authority.test.ts.
const TAKEN_OVER: ScenarioSeed = async (harness) => {
  await scenarioCommands.mutate(pickScenario(makeValidUiState()));
  const peer = await installTestAuthority({ databaseName: harness.databaseName, install: false });
  await peer.authority.initialize();
  await peer.authority.takeover();
  await harness.authority.heartbeat();
  return () => peer.authority.release();
};

const meta = {
  title: "Shell/OwnershipBanner",
  component: OwnershipBanner,
  parameters: { scenario: VALID, layout: "padded" },
  decorators: [withToaster],
} satisfies Meta<typeof OwnershipBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

// Stands in for a second tab coming up read-only (TakenOverByPeer proves the peer path).
const readOnly = () => {
  useAuthorityStore.setState({ ownership: "read-only" });
};

const openTakeover = async (canvas: { getByTestId: typeof screen.getByTestId }) => {
  canvas.getByTestId("ownership-takeover").click();
  const dialog = await screen.findByRole("alertdialog", { name: "Edit here instead?" });
  await waitFor(() => expect(dialog).toBeVisible());
  return dialog;
};

export const Owner: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.queryByTestId("ownership-banner")).toBeNull();
  },
};

export const ReadOnly: Story = {
  beforeEach: readOnly,
  play: async ({ canvas, userEvent }) => {
    const banner = canvas.getByRole("status");
    await expect(banner).toHaveTextContent("Read-only — open in another tab");
    const dialog = await openTakeover(canvas);
    await userEvent.click(within(dialog).getByRole("button", { name: "Edit here" }));
    const toast = await screen.findByText("You can now edit this schedule");
    await waitFor(() => expect(toast).toBeVisible());
    await waitFor(() => expect(canvas.queryByTestId("ownership-banner")).toBeNull());
    await expect(useAuthorityStore.getState().ownership).toBe("owner");
  },
};

export const TakeoverCancelled: Story = {
  beforeEach: readOnly,
  play: async ({ canvas, userEvent }) => {
    const dialog = await openTakeover(canvas);
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await expect(canvas.getByTestId("ownership-banner")).toHaveAttribute(
      "data-ownership",
      "read-only",
    );
    await expect(useAuthorityStore.getState().ownership).toBe("read-only");
  },
};

export const TakenOverByPeer: Story = {
  parameters: { scenario: TAKEN_OVER },
  play: async ({ canvas }) => {
    const banner = await canvas.findByTestId("ownership-banner");
    await expect(banner).toHaveAttribute("data-ownership", "taken-over");
    await expect(banner).toHaveTextContent("Editing moved to another tab");
  },
};

export const Expired: Story = {
  // Stands in for this tab's lease lapsing (a suspended laptop).
  beforeEach: () => {
    useAuthorityStore.setState({ ownership: "expired" });
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("ownership-banner")).toHaveTextContent("Editing paused");
  },
};

export const ReloadRequired: Story = {
  // Stands in for a commit that landed but could not be projected.
  beforeEach: () => {
    useAuthorityStore.setState({ reloadRequired: true });
  },
  play: async ({ canvas }) => {
    const banner = canvas.getByTestId("ownership-banner");
    await expect(banner).toHaveTextContent("Your change was saved");
    // Not clicked: it reloads the preview iframe.
    await expect(canvas.getByRole("button", { name: "Reload" })).toBeVisible();
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
  beforeEach: readOnly,
};
