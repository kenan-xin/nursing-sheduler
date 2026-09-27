import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect } from "storybook/test";
import { Button } from "@/components/ui/button";
import { Callout } from "./callout";

const TITLE = "Roster capture";
const BODY = "The roster for this run was saved in this browser.";

// Every tone is rendered at both ladder placements: the neutral `info` tone takes
// the L1 role on the page plane, the status tones keep their tint at either mount.
const meta = {
  title: "Optimize/Callout",
  component: Callout,
  parameters: { layout: "padded" },
  args: { title: TITLE, children: BODY },
} satisfies Meta<typeof Callout>;

export default meta;
type Story = StoryObj<typeof meta>;

const showsTitleAndBody: Story["play"] = async ({ canvas }) => {
  await expect(canvas.getByText(TITLE)).toBeVisible();
  await expect(canvas.getByText(BODY)).toBeVisible();
};

export const InfoInset: Story = {
  args: { tone: "info", placement: "inset" },
  play: showsTitleAndBody,
};

export const InfoPage: Story = {
  args: { tone: "info", placement: "page" },
  play: showsTitleAndBody,
};

export const WarnInset: Story = {
  args: { tone: "warn", placement: "inset" },
  play: showsTitleAndBody,
};

export const WarnPage: Story = {
  args: { tone: "warn", placement: "page" },
  play: showsTitleAndBody,
};

export const ErrorInset: Story = {
  args: { tone: "error", placement: "inset" },
  play: showsTitleAndBody,
};

export const ErrorPage: Story = {
  args: { tone: "error", placement: "page" },
  play: showsTitleAndBody,
};

export const SuccessInset: Story = {
  args: { tone: "success", placement: "inset" },
  play: showsTitleAndBody,
};

export const SuccessPage: Story = {
  args: { tone: "success", placement: "page" },
  play: showsTitleAndBody,
};

export const WithActions: Story = {
  args: {
    tone: "warn",
    title: "The roster for this run could not be saved",
    children:
      "The finished run is no longer available on the server. Your downloaded XLSX is unaffected.",
    actions: (
      <Button variant="secondary" size="sm">
        Retry saving the roster
      </Button>
    ),
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: "Retry saving the roster" })).toBeVisible();
  },
};

export const Alert: Story = {
  args: { tone: "error", alert: true },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("alert")).toHaveTextContent(TITLE);
  },
};

export const Dark: Story = {
  args: { ...WithActions.args },
  globals: { theme: "dark" },
};
