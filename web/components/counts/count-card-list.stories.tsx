import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, within } from "storybook/test";
import type { CountCard } from "@/lib/scenario";
import {
  LONG_TOKEN,
  expectNoHorizontalOverflow,
  withNarrowFrame,
} from "../../.storybook/story-helpers";
import { CountCardList } from "./count-card-list";

// Cards copied from count-card-list.test.tsx: one contracted, one ordinary, one disabled.
const CONTRACTED: CountCard = {
  uid: "c-exact",
  description: "Full-timer monthly hours",
  person: ["alice"],
  countDates: ["2026-07"],
  countShiftTypes: ["D", "LEAVE"],
  countShiftTypeCoefficients: [
    ["LEAVE", 16],
    ["D", 24],
  ],
  expression: "x = T",
  target: 320,
  weight: Infinity,
  tag: "contracted_hours",
  policy: "exact",
  unit: "half-hour",
};

const ORDINARY: CountCard = {
  uid: "ordinary",
  description: "At least five nights",
  person: ["carol"],
  countDates: ["2026-07"],
  countShiftTypes: ["N12"],
  countShiftTypeCoefficients: [["N12", 2]],
  expression: "x >= T",
  target: 5,
  weight: 3,
};

const DISABLED: CountCard = {
  ...ORDINARY,
  uid: "off",
  description: "Weekend late+ cap",
  countShiftTypes: ["late+"],
  countShiftTypeCoefficients: [["late+", 1]],
  disabled: true,
};

const meta = {
  title: "Counts/CountCardList",
  component: CountCardList,
  parameters: { layout: "padded" },
  args: {
    counts: [CONTRACTED, ORDINARY, DISABLED],
    onEdit: fn(),
    onDuplicate: fn(),
    onDelete: fn(),
    onSetDisabled: fn(),
    onReorder: fn(),
    onConvertToContracted: fn(),
    onConvertToGeneric: fn(),
    convertToGenericUid: null,
    onConfirmConvertToGeneric: fn(),
    onCancelConvertToGeneric: fn(),
  },
} satisfies Meta<typeof CountCardList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByTestId("count-contracted-badge-0")).toHaveTextContent(
      "◆ CONTRACTED HOURS",
    );
    await expect(within(canvas.getByTestId("count-card-0")).getByText("160h")).toBeVisible();
    await userEvent.click(canvas.getByTestId("count-edit-1"));
    await expect(args.onEdit).toHaveBeenCalledWith("ordinary");
    await userEvent.click(canvas.getByTestId("count-dup-1"));
    await expect(args.onDuplicate).toHaveBeenCalledWith("ordinary");
    await userEvent.click(canvas.getByTestId("count-delete-1"));
    await expect(args.onDelete).toHaveBeenCalledWith("ordinary");
    await userEvent.click(canvas.getByTestId("count-disable-1"));
    await expect(args.onSetDisabled).toHaveBeenCalledWith("ordinary", true);
    await userEvent.click(canvas.getByTestId("count-disable-2"));
    await expect(args.onSetDisabled).toHaveBeenCalledWith("off", false);
    await userEvent.click(canvas.getByTestId("count-down-0"));
    await expect(args.onReorder).toHaveBeenCalledWith("c-exact", "ordinary", "after");
    await userEvent.click(canvas.getByTestId("count-convert-generic-0"));
    await expect(args.onConvertToGeneric).toHaveBeenCalledWith("c-exact");
    await userEvent.click(canvas.getByTestId("count-convert-contracted-1"));
    await expect(args.onConvertToContracted).toHaveBeenCalledWith("ordinary");
  },
};

export const Empty: Story = {
  args: { counts: [] },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("counts-list")).toBeEmptyDOMElement();
  },
};

export const ConvertToGenericConfirm: Story = {
  args: { convertToGenericUid: "c-exact" },
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByTestId("count-convert-generic-confirm-0")).toHaveTextContent(
      "This becomes an editable Shift Count.",
    );
    await userEvent.click(canvas.getByTestId("count-convert-generic-commit-0"));
    await expect(args.onConfirmConvertToGeneric).toHaveBeenCalledWith("c-exact");
    await userEvent.click(canvas.getByTestId("count-convert-generic-cancel-0"));
    await expect(args.onCancelConvertToGeneric).toHaveBeenCalledOnce();
  },
};

export const LeaveGuard: Story = {
  args: { leaveGuardUids: new Set(["c-exact"]) },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("count-leave-warning-badge-0")).toHaveTextContent(
      "Leave not credited",
    );
    await expect(canvas.queryByTestId("count-leave-warning-badge-1")).toBeNull();
  },
};

export const LongText: Story = {
  args: {
    counts: [{ ...ORDINARY, description: LONG_TOKEN, person: [LONG_TOKEN] }],
  },
  decorators: [withNarrowFrame],
  play: async ({ canvas }) => {
    await expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"));
  },
};

export const Dark: Story = {
  args: { leaveGuardUids: new Set(["c-exact"]) },
  globals: { theme: "dark" },
};
