import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect } from "storybook/test";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import { computeScenarioFingerprint, pickScenario, scenarioCommands } from "@/lib/store";
import { withScenarioStore } from "../../.storybook/harness";
import { BackupStatusBadge } from "./backup-status-badge";

// Reference story, store-coupled (bead w0e.2). State is seeded through the product's own
// command path, exactly as backup-status-badge.test.tsx does, never by poking the projection.
async function seedAndRecordBackup() {
  const seeded = pickScenario(makeValidUiState());
  await scenarioCommands.mutate(seeded);
  await scenarioCommands.recordBackup(computeScenarioFingerprint(seeded));
}

const meta = {
  title: "SaveLoad/BackupStatusBadge",
  component: BackupStatusBadge,
} satisfies Meta<typeof BackupStatusBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Current: Story = {
  beforeEach: withScenarioStore(seedAndRecordBackup),
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("Backup current")).toBeVisible();
    await expect(canvas.getByTestId("backup-status")).toHaveAttribute("data-status", "current");
  },
};

export const Stale: Story = {
  beforeEach: withScenarioStore(async () => {
    await seedAndRecordBackup();
    await scenarioCommands.mutate({ rangeStart: "2099-01-01" });
  }),
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("Backup out of date")).toBeVisible();
  },
};

// Last on purpose: it must not see the backups recorded by the stories above.
export const NoBackup: Story = {
  beforeEach: withScenarioStore(),
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("No backup")).toBeVisible();
  },
};
