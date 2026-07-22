// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DateRange } from "@/lib/dates";
import { RosterPeriodCard } from "./roster-period-card";

afterEach(() => {
  cleanup();
});

const VALID_RANGE: DateRange = { start: "2026-08-01", end: "2026-08-31" };

describe("RosterPeriodCard — invalid/incomplete range feedback (VR-DC-03)", () => {
  it("shows an error and does not commit when start > end", () => {
    const onCommit = vi.fn();
    render(<RosterPeriodCard range={VALID_RANGE} onCommit={onCommit} />);

    const start = screen.getByTestId("range-start") as HTMLInputElement;
    const end = screen.getByTestId("range-end") as HTMLInputElement;

    // Setting start to a valid on/before date is itself a complete range -> commits.
    fireEvent.change(start, { target: { value: "2026-08-10" } });
    expect(screen.queryByTestId("range-invalid")).toBeNull();

    // Isolate the invalid edit: it must not commit.
    onCommit.mockClear();
    fireEvent.change(end, { target: { value: "2026-08-01" } });
    expect(screen.getByTestId("range-invalid").textContent).toContain(
      "End date must be on or after the start date.",
    );
    expect(onCommit).not.toHaveBeenCalled();
    // The misleading `0 days` duration is suppressed while invalid.
    expect(screen.getByTestId("range-duration").textContent).not.toContain("day");
  });

  it("clears the error and commits once when the range is corrected", () => {
    const onCommit = vi.fn();
    render(<RosterPeriodCard range={VALID_RANGE} onCommit={onCommit} />);

    const start = screen.getByTestId("range-start") as HTMLInputElement;
    const end = screen.getByTestId("range-end") as HTMLInputElement;

    fireEvent.change(start, { target: { value: "2026-08-10" } });
    fireEvent.change(end, { target: { value: "2026-08-01" } });
    expect(screen.getByTestId("range-invalid")).toBeTruthy();

    // Correct the end to a valid on/after date: exactly one commit for this fix.
    onCommit.mockClear();
    fireEvent.change(end, { target: { value: "2026-08-20" } });
    expect(screen.queryByTestId("range-invalid")).toBeNull();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(
      { start: "2026-08-10", end: "2026-08-20" },
      expect.any(Boolean),
    );
  });

  it("shows no error and does not commit when an endpoint is cleared (incomplete)", () => {
    const onCommit = vi.fn();
    render(<RosterPeriodCard range={VALID_RANGE} onCommit={onCommit} />);

    const end = screen.getByTestId("range-end") as HTMLInputElement;
    fireEvent.change(end, { target: { value: "" } });

    expect(screen.queryByTestId("range-invalid")).toBeNull();
    expect(onCommit).not.toHaveBeenCalled();
  });
});
