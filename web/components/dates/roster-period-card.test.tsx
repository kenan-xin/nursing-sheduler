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
    render(<RosterPeriodCard range={VALID_RANGE} importedHolidaysPresent onCommit={onCommit} />);

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
    render(<RosterPeriodCard range={VALID_RANGE} importedHolidaysPresent onCommit={onCommit} />);

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
    render(<RosterPeriodCard range={VALID_RANGE} importedHolidaysPresent onCommit={onCommit} />);

    const end = screen.getByTestId("range-end") as HTMLInputElement;
    fireEvent.change(end, { target: { value: "" } });

    expect(screen.queryByTestId("range-invalid")).toBeNull();
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe("RosterPeriodCard — import switch honest initial state (FR-DC-40)", () => {
  it("keeps auto-import ON for a FRESH roster (no committed range) so the first commit imports", () => {
    const onCommit = vi.fn();
    // Fresh scenario: empty committed range and no SG groups present yet.
    render(
      <RosterPeriodCard
        range={{ start: "", end: "" }}
        importedHolidaysPresent={false}
        onCommit={onCommit}
      />,
    );

    // With an empty range the switch is support-gated (disabled), but the seed is ON.
    // Entering a valid range surfaces it and the first commit carries importHolidays=true.
    fireEvent.change(screen.getByTestId("range-start"), { target: { value: VALID_RANGE.start } });
    fireEvent.change(screen.getByTestId("range-end"), { target: { value: VALID_RANGE.end } });

    const toggle = screen.getByTestId("import-toggle");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.className).toContain("ns-switch--on");
    expect(onCommit).toHaveBeenLastCalledWith(VALID_RANGE, true);
  });

  it("defaults the switch ON with a committed range and imported SG groups present", () => {
    render(<RosterPeriodCard range={VALID_RANGE} importedHolidaysPresent onCommit={vi.fn()} />);

    const toggle = screen.getByTestId("import-toggle");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.className).toContain("ns-switch--on");
    // The import list is rendered, honestly reflecting the present groups.
    expect(screen.queryByTestId("import-count")).not.toBeNull();
  });

  it("defaults the switch OFF for a loaded range WITHOUT the SG groups (no false 'N marked')", () => {
    render(
      <RosterPeriodCard range={VALID_RANGE} importedHolidaysPresent={false} onCommit={vi.fn()} />,
    );

    const toggle = screen.getByTestId("import-toggle");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.className).not.toContain("ns-switch--on");
    // No import summary is shown, so nothing implies an import that never happened.
    expect(screen.queryByTestId("import-changes")).toBeNull();
    expect(screen.queryByTestId("import-count")).toBeNull();
  });
});
