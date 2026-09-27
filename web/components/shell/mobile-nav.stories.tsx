import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { getRouter } from "@storybook/nextjs-vite/navigation.mock";
import { expect, screen, waitFor } from "storybook/test";
import { expectNoHorizontalOverflow } from "../../.storybook/story-helpers";
import { MobileNav } from "./mobile-nav";

// Portalled (Base UI Dialog `side` sheet): drawer queries go through `screen`, never
// `canvas`. Rendered at the 320px `mobile1` viewport, where the drawer is used.
const meta = {
  title: "Shell/MobileNav",
  component: MobileNav,
  parameters: { nextjs: { appDirectory: true, navigation: { pathname: "/dates" } } },
  globals: { viewport: { value: "mobile1", isRotated: false } },
} satisfies Meta<typeof MobileNav>;

export default meta;
type Story = StoryObj<typeof meta>;

const openDrawer = async (canvas: { getByRole: typeof screen.getByRole }) => {
  canvas.getByRole("button", { name: "Open navigation menu" }).click();
  return screen.findByRole("dialog", { name: "Navigation" });
};

export const Closed: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: "Open navigation menu" })).toBeVisible();
    await expect(screen.queryByTestId("mobile-nav-drawer")).toBeNull();
  },
};

export const Open: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Open navigation menu" }));
    const dialog = await screen.findByRole("dialog", { name: "Navigation" });
    await waitFor(() => expect(dialog).toBeVisible());
    await expectNoHorizontalOverflow(screen.getByTestId("mobile-nav-drawer"));
    await userEvent.click(screen.getByTestId("nav-link-/people"));
    await expect(getRouter().push).toHaveBeenCalledWith("/people");
    await waitFor(() => expect(screen.queryByTestId("mobile-nav-drawer")).toBeNull());
  },
};

export const CloseControls: Story = {
  play: async ({ canvas, userEvent }) => {
    const trigger = canvas.getByRole("button", { name: "Open navigation menu" });
    await userEvent.click(trigger);
    await screen.findByRole("dialog", { name: "Navigation" });
    await userEvent.click(screen.getByTestId("mobile-nav-close"));
    await waitFor(() => expect(screen.queryByTestId("mobile-nav-drawer")).toBeNull());

    await userEvent.click(trigger);
    await screen.findByRole("dialog", { name: "Navigation" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("mobile-nav-drawer")).toBeNull());
  },
};

// The drawer is portalled and closed by default, so this play only opens it: axe is the
// test, and it must see the dark drawer.
export const Dark: Story = {
  globals: { theme: "dark" },
  play: async ({ canvas }) => {
    await openDrawer(canvas);
  },
};
