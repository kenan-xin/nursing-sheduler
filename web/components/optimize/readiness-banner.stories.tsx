import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { getRouter } from "@storybook/nextjs-vite/navigation.mock";
import { expect } from "storybook/test";
import { deriveOptimizeReadiness } from "@/lib/optimize/optimize-readiness";
import { ReadinessBanner } from "./readiness-banner";

// Reference story, next/navigation (bead w0e.2; canary for storybookjs/storybook#34688):
// GuardedLink reaches the App Router through useRouter/usePathname, which nextjs-vite mocks.
const ALL_ISSUES = deriveOptimizeReadiness({
  staff: [],
  shifts: [],
  shiftGroups: [],
  rangeStart: "",
  rangeEnd: "",
  counts: [],
}).issues;

const meta = {
  title: "Optimize/ReadinessBanner",
  component: ReadinessBanner,
  parameters: { nextjs: { appDirectory: true } },
  args: { issues: ALL_ISSUES },
} satisfies Meta<typeof ReadinessBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllMissing: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("link", { name: "Staff" }));
    await expect(getRouter().push).toHaveBeenCalledWith("/people");
  },
};

export const DatesOnly: Story = {
  args: { issues: ALL_ISSUES.filter((issue) => issue.kind === "dates") },
  play: async ({ canvas }) => {
    await expect(canvas.getAllByRole("listitem")).toHaveLength(1);
  },
};

export const Ready: Story = {
  args: { issues: [] },
  play: async ({ canvas }) => {
    await expect(canvas.queryByTestId("optimize-readiness")).toBeNull();
  },
};
