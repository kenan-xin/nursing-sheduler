import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect } from "storybook/test";
import { getAssistantDb } from "@/lib/ai/assistant/db";
import { selectReady, useAssistantStore } from "@/lib/ai/assistant/store";
import { withAssistant } from "./assistant-story-harness.test-support";

// Assistant harness self-checks (bead w0e.6). Hidden from the sidebar, run by `pnpm test:stories`.
function ReadyProbe() {
  const ready = useAssistantStore(selectReady);
  return <p>{`ready:${ready}`}</p>;
}

const meta = {
  title: "Harness/Assistant",
  tags: ["!dev"],
  render: () => <ReadyProbe />,
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

// Story files run concurrently in one origin, so each check names its own database.
let readyDb: string | undefined;

export const AssistantReady: Story = {
  beforeEach: withAssistant({ ready: true }),
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("ready:true")).toBeVisible();
    readyDb = getAssistantDb().name;
    await expect(readyDb).toMatch(/^storybook-/);
  },
};

// Declared AFTER the ready story: the store and its database did not leak.
export const AssistantFresh: Story = {
  beforeEach: withAssistant({ ready: false }),
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("ready:false")).toBeVisible();
    const names = (await indexedDB.databases()).map((db) => db.name);
    await expect(names).toContain(getAssistantDb().name);
    await expect(names).not.toContain(readyDb);
  },
};
