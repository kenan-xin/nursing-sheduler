import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, screen, waitFor } from "storybook/test";
import type { ScenarioUiState } from "@/lib/scenario";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import { computeScenarioFingerprint, pickScenario, useScenarioStore } from "@/lib/store";
import { withToaster, type ScenarioSeed } from "../../.storybook/harness";
import { AnonymiseCard } from "./anonymise-card";
import {
  ANONYMISE_TOGGLES,
  defaultAnonymiseToggleState,
  filenameForToggles,
  isAnonymiseDownloadEnabled,
  type AnonymiseToggleState,
} from "./anonymise-export";

// The card clicks a generated <a download>; a window bubble listener cancels the
// download after React has handled the click.
function blockDownloads(): () => void {
  const block = (event: MouseEvent) => {
    if (event.target instanceof HTMLAnchorElement && event.target.hasAttribute("download")) {
      event.preventDefault();
    }
  };
  window.addEventListener("click", block);
  return () => window.removeEventListener("click", block);
}

/** A structurally corrupt draft (two cards share a `uid`): the one thing export blocks. */
function makeDuplicateIdUiState(): ScenarioUiState {
  const state = makeValidUiState();
  state.cardsByKind.requirements = [
    { uid: "dup", shiftType: "D", requiredNumPeople: 1, weight: -1 },
    { uid: "dup", shiftType: "E", requiredNumPeople: 1, weight: -1 },
  ];
  return state;
}

const VALID: ScenarioSeed = pickScenario(makeValidUiState());
const fingerprint = () => computeScenarioFingerprint(pickScenario(useScenarioStore.getState()));

const meta = {
  title: "SaveLoad/AnonymiseCard",
  component: AnonymiseCard,
  parameters: { scenario: VALID, layout: "padded" },
  decorators: [withToaster],
  beforeEach: blockDownloads,
} satisfies Meta<typeof AnonymiseCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvas }) => {
    const defaults = defaultAnonymiseToggleState();
    for (const toggle of ANONYMISE_TOGGLES) {
      const control = canvas.getByRole("switch", { name: toggle.label });
      await expect(control).toHaveAttribute("aria-checked", String(defaults[toggle.key]));
    }
    await expect(canvas.getByText("Free-text descriptions are not changed.")).toBeVisible();
  },
};

export const Download: Story = {
  play: async ({ canvas, userEvent }) => {
    const before = fingerprint();
    await userEvent.click(canvas.getByTestId("anonymise-download-button"));
    const toast = await screen.findByText(
      `Downloaded ${filenameForToggles(defaultAnonymiseToggleState())}`,
    );
    await waitFor(() => expect(toast).toBeVisible());
    // The transform runs on a clone: the live scenario is untouched.
    await expect(fingerprint()).toBe(before);
  },
};

export const AllOff: Story = {
  play: async ({ canvas, userEvent }) => {
    const allOff = {} as AnonymiseToggleState;
    for (const toggle of ANONYMISE_TOGGLES) {
      allOff[toggle.key] = false;
      const control = canvas.getByRole("switch", { name: toggle.label });
      if (control.getAttribute("aria-checked") === "true") await userEvent.click(control);
    }
    const button = canvas.getByTestId("anonymise-download-button");
    await waitFor(() =>
      expect(button.hasAttribute("disabled")).toBe(!isAnonymiseDownloadEnabled(allOff)),
    );
  },
};

export const ScatterWarning: Story = {
  play: async ({ canvas, userEvent }) => {
    // The valid fixture has no WORKDAY/NON-WORKDAY date groups, so scatter falls back.
    await userEvent.click(canvas.getByTestId("anonymise-toggle-scatter"));
    await expect(await canvas.findByTestId("anonymise-scatter-fallback-warning")).toBeVisible();
  },
};

export const InvalidScenario: Story = {
  parameters: { scenario: pickScenario(makeDuplicateIdUiState()) },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("anonymise-download-button"));
    await expect(await canvas.findByTestId("scenario-export-issues")).toBeVisible();
    await expect(screen.queryByText(/^Downloaded /)).toBeNull();
  },
};

export const Dark: Story = {
  globals: { theme: "dark" },
};
