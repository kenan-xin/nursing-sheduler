import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn } from "storybook/test";
import { useModeStore } from "@/lib/mode/mode";
import { getNavGroupsForMode } from "./nav-config";
import { NavList } from "./sidebar-nav";

// Mode comes from the real store; the global reset starts every story in Guided.
const meta = {
  title: "Shell/NavList",
  component: NavList,
  decorators: [
    (Story) => (
      <div className="w-72">
        <Story />
      </div>
    ),
  ],
  args: { activePath: "/dates", onNavigate: fn() },
} satisfies Meta<typeof NavList>;

export default meta;
type Story = StoryObj<typeof meta>;

const guidedLinkCount = getNavGroupsForMode("guided").flatMap((group) => group.items).length;

const advanced = () => {
  useModeStore.setState({ mode: "advanced" });
};

const railFrame: Meta["decorators"] = [
  (Story) => (
    <div className="w-[60px]">
      <Story />
    </div>
  ),
];

export const Guided: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByTestId("nav-link-/dates")).toHaveAttribute("aria-current", "page");
    await expect(canvas.getByTestId("nav-step-/dates")).toHaveTextContent("1");
    await expect(canvas.queryByTestId("nav-group-constraints")).toBeNull();
    await userEvent.click(canvas.getByTestId("nav-link-/people"));
    await expect(args.onNavigate).toHaveBeenCalledOnce();
    await expect(args.onNavigate).toHaveBeenCalledWith("/people");
  },
};

export const Advanced: Story = {
  beforeEach: advanced,
  play: async ({ canvas }) => {
    const constraints = canvas.getByTestId("nav-group-constraints");
    await expect(constraints.querySelectorAll("[data-testid^='nav-link-']")).toHaveLength(5);
    await expect(canvas.queryAllByTestId(/^nav-step-/)).toHaveLength(0);
  },
};

export const Collapsed: Story = {
  args: { collapsed: true },
  decorators: railFrame,
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: "Dates · step 1" })).toBeVisible();
    await expect(canvas.getByTestId("nav-group-label-setup")).toHaveAttribute("role", "separator");
    await expect(canvas.getByRole("separator", { name: "Set up" })).toBeInTheDocument();
    await expect(canvas.queryAllByTestId(/^nav-link-/)).toHaveLength(guidedLinkCount);
  },
};

export const CollapsedAdvanced: Story = {
  args: { collapsed: true },
  decorators: railFrame,
  beforeEach: advanced,
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: "Dates" })).toBeVisible();
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
