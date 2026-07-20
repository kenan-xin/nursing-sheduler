// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RunOptionsForm, type RunOptionsFormProps } from "./run-options-form";

afterEach(() => cleanup());

function setup(over: Partial<RunOptionsFormProps> = {}) {
  const props: RunOptionsFormProps = {
    prettify: true,
    anonymize: true,
    timeout: "300",
    timeoutError: null,
    optionsDisabled: false,
    submitEnabled: true,
    submitting: false,
    disabledReason: null,
    onPrettifyChange: vi.fn(),
    onAnonymizeChange: vi.fn(),
    onTimeoutChange: vi.fn(),
    onSubmit: vi.fn(),
    ...over,
  };
  render(<RunOptionsForm {...props} />);
  return props;
}

describe("RunOptionsForm", () => {
  it("renders the prettify and anonymize toggles with old-app copy", () => {
    setup();
    expect(screen.getByRole("switch", { name: "Prettify XLSX" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Anonymize schedule data" })).toBeInTheDocument();
    expect(screen.getByText("Apply formatting to the generated workbook.")).toBeInTheDocument();
  });

  it("toggles prettify and anonymize", async () => {
    const props = setup({ prettify: false, anonymize: false });
    await userEvent.click(screen.getByRole("switch", { name: "Prettify XLSX" }));
    expect(props.onPrettifyChange).toHaveBeenLastCalledWith(true, expect.anything());
    await userEvent.click(screen.getByRole("switch", { name: "Anonymize schedule data" }));
    expect(props.onAnonymizeChange).toHaveBeenLastCalledWith(true, expect.anything());
  });

  it("edits the timeout field", async () => {
    const props = setup({ timeout: "" });
    await userEvent.type(screen.getByLabelText("Solver Timeout"), "5");
    expect(props.onTimeoutChange).toHaveBeenCalledWith("5");
  });

  it("shows the timeout validation error and marks the input invalid", () => {
    setup({ timeoutError: "Solver timeout must be a valid positive integer." });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Solver timeout must be a valid positive integer.",
    );
    expect(screen.getByLabelText("Solver Timeout")).toHaveAttribute("aria-invalid", "true");
  });

  it("submits the form", async () => {
    const props = setup();
    await userEvent.click(screen.getByTestId("optimize-submit"));
    expect(props.onSubmit).toHaveBeenCalled();
  });

  it("disables submit and shows the disabled reason", () => {
    setup({
      submitEnabled: false,
      disabledReason: "Backend unavailable. Check that the configured backend is running.",
    });
    expect(screen.getByTestId("optimize-submit")).toBeDisabled();
    expect(screen.getByTestId("optimize-disabled-reason")).toHaveTextContent(
      "Backend unavailable.",
    );
  });

  it("shows the optimizing state while submitting", () => {
    setup({ submitting: true });
    expect(screen.getByTestId("optimize-submit")).toHaveTextContent("Optimizing…");
    expect(screen.getByTestId("optimize-submit")).toBeDisabled();
  });

  it("locks the options while a run is active", () => {
    setup({ optionsDisabled: true });
    expect(screen.getByRole("switch", { name: "Prettify XLSX" })).toHaveAttribute("data-disabled");
    expect(screen.getByLabelText("Solver Timeout")).toBeDisabled();
  });
});
