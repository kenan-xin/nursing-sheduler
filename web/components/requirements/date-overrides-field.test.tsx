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
});
