import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn } from "storybook/test";
import type { OptimizeServerInfo } from "@/lib/optimize";
import { ServerIdentity } from "./server-identity";

function info(over: Partial<OptimizeServerInfo> = {}): OptimizeServerInfo {
  return {
    status: "online",
    apiVersion: "alpha",
    backendVersion: "1.2.3",
    clientVersion: "1.2.3",
    versionTier: "identical",
    semanticProfile: null,
    unavailableReason: null,
    recheck: fn(),
    ...over,
  };
}

const meta = {
  title: "Optimize/ServerIdentity",
  component: ServerIdentity,
  parameters: { layout: "padded" },
  args: { info: info() },
} satisfies Meta<typeof ServerIdentity>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Online: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByTestId("optimize-server-identity")).toHaveTextContent(
      "API version: alpha · Frontend version: 1.2.3 · Backend version: 1.2.3",
    );
    await expect(canvas.getByText("Online")).toBeVisible();
    await userEvent.click(canvas.getByTestId("optimize-recheck"));
    await expect(args.info.recheck).toHaveBeenCalledOnce();
  },
};

export const Checking: Story = {
  args: { info: info({ status: "checking", versionTier: null, backendVersion: null }) },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Checking")).toBeVisible();
  },
};

export const Offline: Story = {
  args: {
    info: info({
      status: "offline",
      versionTier: null,
      backendVersion: null,
      unavailableReason: "backend_unreachable",
    }),
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("optimize-server-offline")).toHaveTextContent(
      "backend_unreachable",
    );
  },
};

export const VersionMismatch: Story = {
  args: { info: info({ versionTier: "incompatible", backendVersion: "9.9.9" }) },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("optimize-version-mismatch")).toHaveTextContent(
      "Frontend and backend versions do not match.",
    );
  },
};

export const VersionNote: Story = {
  args: { info: info({ versionTier: "compatible" }) },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("optimize-version-note")).toHaveTextContent(
      "same version line",
    );
  },
};

export const Dark: Story = {
  args: { ...Offline.args },
  globals: { theme: "dark" },
};
