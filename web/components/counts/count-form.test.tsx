// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeValidUiState } from "@/lib/scenario/test-fixtures";
import { CountForm } from "./count-form";
import { emptyCountForm, type CountFormState } from "./counts-model";

afterEach(cleanup);

function renderForm(initialForm: CountFormState) {
  render(
    <CountForm
      state={makeValidUiState()}
      mode="add"
      initialForm={initialForm}
      onSave={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
}

describe("Count weight sentence (C1)", () => {
  it("a new linear rule defaults to +4 and reads as the Preview does", () => {
    renderForm({ ...emptyCountForm(), target: 5 });
    expect(screen.getByTestId("weight-field-input")).toHaveValue("4");
    expect(screen.getByTestId("count-strength")).toHaveTextContent(
      "At least 5: kept to where possible (weight 4).",
    );
    expect(screen.queryByTestId("count-negative-weight-warning")).toBeNull();
  });

  it("warns, without blocking, on a negative weight for a linear rule", () => {
    renderForm({ ...emptyCountForm(), target: 5, weight: -1 });
    expect(screen.getByTestId("count-strength")).toHaveTextContent(
      "At least 5: avoided where possible (weight -1).",
    );
    expect(screen.getByTestId("count-negative-weight-warning")).toBeInTheDocument();
  });

  it("switching an untouched default to the squared form gives -4", async () => {
    renderForm({ ...emptyCountForm(), target: 5 });
    await userEvent.click(screen.getByTestId("expression-field-op-sq"));
    expect(screen.getByTestId("weight-field-input")).toHaveValue("-4");
    expect(screen.getByTestId("count-strength")).toHaveTextContent(
      "Close to 5: pulled toward 5 (weight -4).",
    );
    expect(screen.queryByTestId("count-negative-weight-warning")).toBeNull();
  });
});
