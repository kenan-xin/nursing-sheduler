import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn } from "storybook/test";
import {
  LONG_TOKEN,
  expectNoHorizontalOverflow,
  withNarrowFrame,
} from "../../.storybook/story-helpers";
import {
  CoefficientFields,
  type CoefficientDomain,
  type CoefficientPair,
} from "./coefficient-fields";

// Shared per-source coefficient sub-editor. Eligibility is re-derived from the
// `selection` prop, so an un-synced `pairs` is safe to pass straight in.
const DOMAIN: CoefficientDomain = {
  items: [{ id: "D" }, { id: "N" }, { id: "OFF" }, { id: "LEAVE" }],
  groups: [
    { id: "Seniors", members: ["D", "N"] },
    { id: "ALL", members: ["D", "N", "OFF", "LEAVE"] },
  ],
};

const DERIVED_DOMAIN: CoefficientDomain = {
  items: [
    { id: "D", derivation: { minutes: 480, credit: false } },
    { id: "LEAVE", derivation: { minutes: 480, credit: true } },
    { id: "N" },
  ],
  groups: [],
};

const FILLED: CoefficientPair[] = [
  ["D", 1],
  ["N", 3],
];

const meta = {
  title: "CardEditor/CoefficientFields",
  component: CoefficientFields,
  parameters: { layout: "padded" },
  args: {
    selection: ["D", "N"],
    pairs: FILLED,
    domain: DOMAIN,
    onChange: fn(),
  },
} satisfies Meta<typeof CoefficientFields>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ args, canvas, userEvent }) => {
    // Controlled input: the keystroke appends to "1", so "17" parses to 17.
    await userEvent.type(canvas.getByRole("spinbutton", { name: "Coefficient for D" }), "7");
    // Selecting D + N also makes the Seniors group eligible (all members covered).
    await expect(args.onChange).toHaveBeenCalledWith(
      [
        ["D", 17],
        ["N", 3],
        ["Seniors", ""],
      ],
      "D",
    );
  },
};

export const WithCoverage: Story = {
  args: {
    pairs: [
      ["D", 2],
      ["N", ""],
    ],
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("coefficient-fields-coverage")).toHaveTextContent(
      "2 types need a coefficient",
    );
  },
};

export const DerivedHints: Story = {
  args: { selection: ["D", "LEAVE", "N"], pairs: [], domain: DERIVED_DOMAIN, derivedHints: true },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("coefficient-fields-hint-D")).toHaveTextContent(
      "8h × 2 · from working time",
    );
    await expect(canvas.getByTestId("coefficient-fields-hint-LEAVE")).toHaveTextContent(
      "8h credit · editable",
    );
    await expect(canvas.getByTestId("coefficient-fields-hint-N")).toHaveTextContent(
      "no working time — set manually",
    );
  },
};

export const WithErrors: Story = {
  args: {
    errorsById: { D: "Coefficient for D must be an integer of at least 1" },
    aggregateError: "Shift type coefficients overlap: D, Seniors include D",
  },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByText("Coefficient for D must be an integer of at least 1"),
    ).toBeVisible();
    await expect(canvas.getByTestId("coefficient-fields-aggregate-error")).toHaveTextContent(
      "Shift type coefficients overlap: D, Seniors include D",
    );
  },
};

export const Empty: Story = {
  args: { selection: [], pairs: [] },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("coefficient-fields-empty")).toHaveTextContent(
      "Coefficients are not needed when no coefficient is selected.",
    );
  },
};

export const LongText: Story = {
  decorators: [withNarrowFrame],
  args: {
    selection: [LONG_TOKEN],
    pairs: [],
    domain: { items: [{ id: LONG_TOKEN }], groups: [] },
  },
  play: async ({ canvas }) => {
    await expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"));
    // Single-line slot: the full id stays discoverable through its title.
    await expect(canvas.getByTitle(LONG_TOKEN)).toBeVisible();
  },
};

// Last on purpose: the next light story would prove the theme reset.
export const Dark: Story = {
  args: { ...WithCoverage.args },
  globals: { theme: "dark" },
};
