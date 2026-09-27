import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { toast } from "sonner";
import { expect, screen, waitFor } from "storybook/test";
import { noteGuidedArrival, peekGuidedArrival } from "@/components/shell/guided-arrival";
import { Button } from "@/components/ui/button";
import { useChangeHighlightStore } from "@/lib/change-highlight/store";
import { useModeStore } from "@/lib/mode/mode";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import {
  pickScenario,
  scenarioCommands,
  useAuthorityStore,
  useHotStore,
  useScenarioStore,
} from "@/lib/store";
import type { ScenarioSeed } from "./harness";
import { withResetTransientStores, withScenarioStore, withToaster } from "./harness";

// Harness self-checks (bead w0e.2). Hidden from the sidebar, run by `pnpm test:stories`.
function StaffCount() {
  const count = useScenarioStore((state) => state.staff.length);
  return <p>{`staff:${count}`}</p>;
}

const meta = {
  title: "Harness/State",
  tags: ["!dev"],
  render: () => <StaffCount />,
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const SeededScenario: Story = {
  beforeEach: withScenarioStore(async () => {
    await scenarioCommands.mutate(pickScenario(makeValidUiState()));
  }),
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("staff:2")).toBeVisible();
  },
};

// Declared AFTER the seeded story on purpose: it proves the previous story's scenario did
// not leak AND that its database was deleted (only this story's own database remains).
export const FreshScenario: Story = {
  beforeEach: withScenarioStore(),
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("staff:0")).toBeVisible();
    const ours = (await indexedDB.databases()).filter((db) => db.name?.startsWith("storybook-"));
    await expect(ours).toHaveLength(1);
  },
};

const TWO_STAFF: ScenarioSeed = pickScenario(makeValidUiState());

// Bucket C stories declare their scenario as data; the global hook installs it.
export const ParameterSeed: Story = {
  parameters: { scenario: TWO_STAFF },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("staff:2")).toBeVisible();
    await expect(useHotStore.getState().hydrationStatus).toBe("ready");
    await expect(useAuthorityStore.getState().canUndo).toBe(true); // a patch seed is one mutate
  },
};

export const ParameterOverride: Story = {
  parameters: { scenario: "empty" },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("staff:0")).toBeVisible();
    await expect(useAuthorityStore.getState().canUndo).toBe(false);
    const ours = (await indexedDB.databases()).filter((db) => db.name?.startsWith("storybook-"));
    await expect(ours).toHaveLength(1);
  },
};

// Declared right after a scenario story, with NO scenario of its own: the previous
// story's projection, hydration status and ownership must all be gone.
export const TornDown: Story = {
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("staff:0")).toBeVisible();
    await expect(useHotStore.getState().hydrationStatus).toBe("unhydrated");
    await expect(useAuthorityStore.getState().ownership).toBe("unknown");
    const ours = (await indexedDB.databases()).filter((db) => db.name?.startsWith("storybook-"));
    await expect(ours).toHaveLength(0);
  },
};

export const TransientStoresReset: Story = {
  play: async () => {
    useChangeHighlightStore.setState({ keys: new Set(["probe"]) });
    withResetTransientStores();
    await expect(useChangeHighlightStore.getState().keys.size).toBe(0);
  },
};

// Bucket B stories switch mode and stage Guided arrivals; both stores are module singletons.
export const ModeReset: Story = {
  play: async () => {
    useModeStore.getState().setMode("advanced");
    useModeStore.getState().markAdopted();
    noteGuidedArrival("/shift-counts");
    withResetTransientStores();
    await expect(useModeStore.getState().mode).toBe("guided");
    await expect(useModeStore.getState().adoption).toBe("unhydrated");
    await expect(peekGuidedArrival()).toBeNull();
  },
};

export const Toast: Story = {
  decorators: [withToaster],
  render: () => <Button onClick={() => toast("Roster saved")}>Save</Button>,
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Save" }));
    // sonner mounts the toast at opacity 0 and animates it in.
    const message = await screen.findByText("Roster saved");
    await waitFor(() => expect(message).toBeVisible());
  },
};
