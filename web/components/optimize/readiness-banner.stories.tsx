import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { getRouter } from "@storybook/nextjs-vite/navigation.mock";
import { expect } from "storybook/test";
import { deriveOptimizeReadiness } from "@/lib/optimize/optimize-readiness";
import { ReadinessBanner } from "./readiness-banner";

// next/navigation canary (storybookjs/storybook#34688): GuardedLink reaches the
// App Router through useRouter/usePathname.
const meta = {
  title: "Optimize/ReadinessBanner",
  component: ReadinessBanner,
  parameters: { nextjs: { appDirectory: true } },
  args: {
    issues: deriveOptimizeReadiness({
      staff: [],
      shifts: [],
      shiftGroups: [],
      rangeStart: "",
      rangeEnd: "",
    }).issues,
  },
} satisfies Meta<typeof ReadinessBanner>;

export default meta;

export const AllMissing: StoryObj<typeof meta> = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("link", { name: "Staff" }));
    await expect(getRouter().push).toHaveBeenCalledWith("/people");
  },
};
