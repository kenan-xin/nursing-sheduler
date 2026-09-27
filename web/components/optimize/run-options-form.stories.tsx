import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fireEvent, fn } from "storybook/test";
import { RunOptionsForm } from "./run-options-form";

const meta = {
  title: "Optimize/RunOptionsForm",
  component: RunOptionsForm,
  parameters: { layout: "padded" },
  args: {
    stats: { nurses: 12, days: 28, shifts: 3, rulesOn: 5 },
    prettify: false,
    anonymize: false,
    timeout: "300",
    timeoutBounds: { default: 300, minimum: 1, maximum: 3600 },
    timeoutError: null,
    optionsDisabled: false,
    submitEnabled: true,
    submitting: false,
    disabledReason: null,
    onPrettifyChange: fn(),
    onAnonymizeChange: fn(),
    onTimeoutChange: fn(),
    onSubmit: fn(),
  },
} satisfies Meta<typeof RunOptionsForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByTestId("optimize-submit"));
    await expect(args.onSubmit).toHaveBeenCalledOnce();

    // Base UI's Switch passes its own event details as a second argument.
    await userEvent.click(canvas.getByRole("switch", { name: "Prettify XLSX" }));
    await expect(args.onPrettifyChange).toHaveBeenCalledWith(true, expect.anything());

    await userEvent.click(canvas.getByRole("switch", { name: "Anonymize schedule data" }));
    await expect(args.onAnonymizeChange).toHaveBeenCalledWith(true, expect.anything());

    // The input is controlled by the caller's `timeout`, so a no-op spy cannot hold
    // the typed value: drive the change event directly.
    fireEvent.change(canvas.getByLabelText("Solver Timeout"), { target: { value: "5" } });
    await expect(args.onTimeoutChange).toHaveBeenCalledWith("5");
  },
};

export const Submitting: Story = {
  args: { submitting: true },
  play: async ({ canvas }) => {
    const submit = canvas.getByTestId("optimize-submit");
    await expect(submit).toBeDisabled();
    await expect(submit).toHaveTextContent("Optimising…");
  },
};

export const OptionsDisabled: Story = {
  args: { optionsDisabled: true },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("switch", { name: "Prettify XLSX" })).toHaveAttribute(
      "data-disabled",
    );
    await expect(canvas.getByLabelText("Solver Timeout")).toBeDisabled();
  },
};

export const SubmitDisabled: Story = {
  args: {
    submitEnabled: false,
    disabledReason: "Backend unavailable. Check that the configured backend is running.",
  },
  play: async ({ args, canvas }) => {
    const submit = canvas.getByTestId("optimize-submit");
    await expect(submit).toBeDisabled();
    await expect(canvas.getByTestId("optimize-disabled-reason")).toHaveTextContent(
      "Backend unavailable.",
    );
    // `userEvent` refuses a disabled control (`pointer-events: none`), so dispatch the
    // click directly: the point is that the handler still does not fire.
    fireEvent.click(submit);
    await expect(args.onSubmit).not.toHaveBeenCalled();
  },
};

export const TimeoutError: Story = {
  args: { timeoutError: "Solver timeout must be a valid positive integer." },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("alert")).toHaveTextContent(
      "Solver timeout must be a valid positive integer.",
    );
    await expect(canvas.getByLabelText("Solver Timeout")).toHaveAttribute("aria-invalid", "true");
  },
};

export const Dark: Story = {
  args: { ...Ready.args },
  globals: { theme: "dark" },
};
