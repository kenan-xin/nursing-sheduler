// @vitest-environment jsdom
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DateOverridesField } from "./date-overrides-field";
import type { OverrideRow } from "./requirements-model";

afterEach(cleanup);

const DATES = [
  { iso: "2026-10-14", label: "Wed 14 Oct" },
  { iso: "2026-10-15", label: "Thu 15 Oct" },
];

// bd memory `long-user-text-no-overflow` / nursing-sheduler-w0e.21: a date-group
// label is arbitrary user input — the native select must stay inside its row and
// expose the full selected value on hover.
const LONG_TOKEN = "ward8-east-extended-weekend-night-cover-rotation-".repeat(3).slice(0, 120);

function Harness({ initial = [] as OverrideRow[], onRows = (_: OverrideRow[]) => {} }) {
  const [rows, setRows] = React.useState(initial);
  return (
    <DateOverridesField
      rows={rows}
      dates={DATES}
      onChange={(next) => {
        setRows(next);
        onRows(next);
      }}
    />
  );
}

describe("DateOverridesField", () => {
  it("adds a row on the first free date, then edits its number", () => {
    let last: OverrideRow[] = [];
    render(<Harness onRows={(r) => (last = r)} />);
    fireEvent.click(screen.getByTestId("date-overrides-add"));
    expect(last).toEqual([{ date: "2026-10-14", requiredNumPeople: "" }]);
    fireEvent.change(screen.getByLabelText("Number of people on exception 1"), {
      target: { value: "1" },
    });
    expect(last).toEqual([{ date: "2026-10-14", requiredNumPeople: 1 }]);
  });

  it("changes the date and removes a row", () => {
    let last: OverrideRow[] = [];
    render(
      <Harness
        initial={[{ date: "2026-10-14", requiredNumPeople: 1 }]}
        onRows={(r) => (last = r)}
      />,
    );
    fireEvent.change(screen.getByLabelText("Date of exception 1"), {
      target: { value: "2026-10-15" },
    });
    expect(last).toEqual([{ date: "2026-10-15", requiredNumPeople: 1 }]);
    fireEvent.click(screen.getByRole("button", { name: "Remove exception 1" }));
    expect(last).toEqual([]);
  });

  it("keeps a date the rule no longer covers visible, so its error can name it", () => {
    render(<Harness initial={[{ date: "2026-10-20", requiredNumPeople: 1 }]} />);
    expect((screen.getByLabelText("Date of exception 1") as HTMLSelectElement).value).toBe(
      "2026-10-20",
    );
  });

  it("offers no add once every covered date has a row", () => {
    render(
      <Harness
        initial={[
          { date: "2026-10-14", requiredNumPeople: 1 },
          { date: "2026-10-15", requiredNumPeople: 1 },
        ]}
      />,
    );
    expect(screen.getByTestId("date-overrides-add")).toBeDisabled();
  });

  it("constrains a long option label so the select cannot overflow its row", () => {
    render(
      <DateOverridesField
        rows={[{ date: "2026-10-14", requiredNumPeople: 2 }]}
        dates={[{ iso: "2026-10-14", label: LONG_TOKEN }]}
        onChange={() => {}}
      />,
    );
    const select = screen.getByLabelText("Date of exception 1");
    expect(select).toHaveClass("max-w-full");
    expect(select).toHaveAttribute("title", LONG_TOKEN);
  });
});
