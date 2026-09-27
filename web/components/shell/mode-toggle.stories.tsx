import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { getRouter } from "@storybook/nextjs-vite/navigation.mock";
import { expect, waitFor } from "storybook/test";
import { useModeStore } from "@/lib/mode/mode";
import { ModeToggle } from "./mode-toggle";
import { useNavGuardStore } from "./nav-guard-store";

// Mode is the real store (reset to Guided before every story); the router is the
// nextjs-vite mock, so a Guided redirect shows up as a `replace` spy call.
const meta = {
  title: "Shell/ModeToggle",
  component: ModeToggle,
  parameters: { nextjs: { appDirectory: true, navigation: { pathname: "/dates" } } },
  decorators: [
    (Story) => (
      <div className="w-60">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ModeToggle>;

export default meta;
type Story = StoryObj<typeof meta>;

const advancedOnlyRoute = { nextjs: { navigation: { pathname: "/shift-counts" } } };

const advanced = () => {
  useModeStore.setState({ mode: "advanced" });
};

export const Guided: Story = {
  play: async ({ canvas, userEvent }) => {
    const tab = canvas.getByTestId("mode-toggle-advanced");
    await userEvent.click(tab);
    await expect(useModeStore.getState().mode).toBe("advanced");
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(tab).toHaveFocus();
    await expect(getRouter().replace).not.toHaveBeenCalled();
    await expect(getRouter().push).not.toHaveBeenCalled();
  },
};

export const Keyboard: Story = {
  play: async ({ canvas, userEvent }) => {
    canvas.getByTestId("mode-toggle-guided").focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect(canvas.getByTestId("mode-toggle-advanced")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(canvas.getByTestId("mode-toggle-advanced")).toHaveFocus();
    await userEvent.keyboard("{Home}");
    await expect(canvas.getByTestId("mode-toggle-guided")).toHaveAttribute("aria-selected", "true");
    await expect(useModeStore.getState().mode).toBe("guided");
  },
};

export const AdvancedOnlyRoute: Story = {
  parameters: advancedOnlyRoute,
  beforeEach: advanced,
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("mode-toggle-guided"));
    await expect(useModeStore.getState().mode).toBe("guided");
    await expect(getRouter().replace).toHaveBeenCalledWith("/rules");
    await expect(getRouter().push).not.toHaveBeenCalled();
  },
};

export const StagedByDraft: Story = {
  parameters: advancedOnlyRoute,
  beforeEach: () => {
    advanced();
    return useNavGuardStore.getState().registerDraft({ id: "story-draft", label: "Unsaved card" });
  },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("mode-toggle-guided"));
    await expect(useModeStore.getState().mode).toBe("advanced");
    await expect(useNavGuardStore.getState().pendingIntent?.kind).toBe("mode-transition");
    await expect(getRouter().replace).not.toHaveBeenCalled();
    useNavGuardStore.getState().cancel();
    await waitFor(() => expect(canvas.getByTestId("mode-toggle-advanced")).toHaveFocus());
    await expect(useModeStore.getState().mode).toBe("advanced");
  },
};

export const Compact: Story = {
  args: { compact: true },
  play: async ({ canvas, userEvent }) => {
    const pill = canvas.getByRole("button", { name: "Guided mode — switch to Advanced" });
    await expect(pill).toHaveTextContent("GUI");
    await userEvent.click(pill);
    await expect(pill).toHaveTextContent("ADV");
    await expect(pill).toHaveAttribute("data-mode", "advanced");
    await expect(useModeStore.getState().mode).toBe("advanced");
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
