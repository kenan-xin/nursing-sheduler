// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DateRange } from "@/lib/dates";
import { changeKeys } from "@/lib/change-highlight/keys";
import { clearChangeHighlight, showChangeHighlight } from "@/lib/change-highlight/store";
import {
  mergeSingaporeHolidays,
  setSingaporeHolidays,
  SINGAPORE_HOLIDAYS,
} from "@/lib/dates/holidays-sg";
import { RosterPeriodCard } from "./roster-period-card";

afterEach(() => {
  cleanup();
});

const VALID_RANGE: DateRange = { start: "2026-08-01", end: "2026-08-31" };

describe("RosterPeriodCard — change highlight", () => {
  afterEach(() => clearChangeHighlight());
  it("outlines the card when an Apply changed the roster period", () => {
    render(<RosterPeriodCard range={VALID_RANGE} importedHolidaysPresent onCommit={vi.fn()} />);
    const card = screen.getByTestId("roster-period-card");
    expect(card).toHaveAttribute("data-change-key", changeKeys.rosterRange());
    expect(card).not.toHaveAttribute("data-change-highlight");
    act(() => showChangeHighlight([changeKeys.rosterRange()]));
    expect(card).toHaveAttribute("data-change-highlight", "true");
  });
});

describe("RosterPeriodCard — invalid/incomplete range feedback (VR-DC-03)", () => {
  it("says what the holiday import really does (F7)", () => {
    render(<RosterPeriodCard range={VALID_RANGE} importedHolidaysPresent onCommit={vi.fn()} />);
    expect(
      screen.getByText(
        "Adds WORKDAY, NON-WORKDAY and PH date groups. They change nothing until a staffing rule uses them.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/like weekends/)).not.toBeInTheDocument();
  });

  it("shows an error and does not commit when start > end", () => {
    const onCommit = vi.fn();
    render(<RosterPeriodCard range={VALID_RANGE} importedHolidaysPresent onCommit={onCommit} />);

    const start = screen.getByTestId("range-start") as HTMLInputElement;
    const end = screen.getByTestId("range-end") as HTMLInputElement;

    fireEvent.change(start, { target: { value: "2026-08-10" } });
    expect(screen.queryByTestId("range-invalid")).toBeNull();

    // Isolate the invalid edit: it must not commit.
    onCommit.mockClear();
    fireEvent.change(end, { target: { value: "2026-08-01" } });
    expect(screen.getByTestId("range-invalid").textContent).toContain(
      "End date must be on or after the start date.",
    );
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByTestId("range-apply")).toBeDisabled();
    // The misleading `0 days` duration is suppressed while invalid.
    expect(screen.getByTestId("range-duration").textContent).not.toContain("day");
  });

  it("clears the error and commits once on Apply when the range is corrected", () => {
    const onCommit = vi.fn();
    render(<RosterPeriodCard range={VALID_RANGE} importedHolidaysPresent onCommit={onCommit} />);

    const start = screen.getByTestId("range-start") as HTMLInputElement;
    const end = screen.getByTestId("range-end") as HTMLInputElement;

    fireEvent.change(start, { target: { value: "2026-08-10" } });
    fireEvent.change(end, { target: { value: "2026-08-01" } });
    expect(screen.getByTestId("range-invalid")).toBeTruthy();

    fireEvent.change(end, { target: { value: "2026-08-20" } });
    expect(screen.queryByTestId("range-invalid")).toBeNull();
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("range-apply"));
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

describe("RosterPeriodCard — draft with Apply and Cancel (v1 parity)", () => {
  it("never commits per keystroke, even when an intermediate value is a valid shorter range", () => {
    const onCommit = vi.fn();
    render(<RosterPeriodCard range={VALID_RANGE} importedHolidaysPresent onCommit={onCommit} />);
    const end = screen.getByTestId("range-end");
    // Segment typing can emit a shorter valid range on the way to the real one.
    fireEvent.change(end, { target: { value: "2026-08-03" } });
    fireEvent.change(end, { target: { value: "2026-08-30" } });
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("range-apply"));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith({ start: "2026-08-01", end: "2026-08-30" }, true);
  });

  it("Cancel restores the committed range and switch without committing", () => {
    const onCommit = vi.fn();
    render(<RosterPeriodCard range={VALID_RANGE} importedHolidaysPresent onCommit={onCommit} />);
    expect(screen.getByTestId("range-apply")).toBeDisabled();
    expect(screen.getByTestId("range-cancel")).toBeDisabled();

    fireEvent.change(screen.getByTestId("range-end"), { target: { value: "2026-08-10" } });
    fireEvent.click(screen.getByTestId("import-toggle"));
    expect(screen.getByTestId("import-toggle").getAttribute("aria-checked")).toBe("false");

    fireEvent.click(screen.getByTestId("range-cancel"));
    expect((screen.getByTestId("range-end") as HTMLInputElement).value).toBe(VALID_RANGE.end);
    expect(screen.getByTestId("import-toggle").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("range-apply")).toBeDisabled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("the import switch is part of the draft: toggling alone commits only on Apply", () => {
    const onCommit = vi.fn();
    render(<RosterPeriodCard range={VALID_RANGE} importedHolidaysPresent onCommit={onCommit} />);
    fireEvent.click(screen.getByTestId("import-toggle"));
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("range-apply"));
    expect(onCommit).toHaveBeenCalledWith(VALID_RANGE, false);
    // Applied: the draft is clean again.
    expect(screen.getByTestId("range-apply")).toBeDisabled();
  });

  it("warns how many requests and leave days the new range removes, before Apply", () => {
    const countRemovals = vi.fn(() => ({ requests: 3, leaveDays: 1 }));
    render(
      <RosterPeriodCard
        range={VALID_RANGE}
        importedHolidaysPresent
        onCommit={vi.fn()}
        countRemovals={countRemovals}
      />,
    );
    expect(screen.queryByTestId("range-removal-warning")).toBeNull();

    fireEvent.change(screen.getByTestId("range-end"), { target: { value: "2026-08-20" } });
    expect(countRemovals).toHaveBeenLastCalledWith({ start: "2026-08-01", end: "2026-08-20" });
    expect(screen.getByTestId("range-removal-warning").textContent).toBe(
      "3 requests and 1 leave day fall outside the new range and will be removed.",
    );
  });

  it("shows no warning when the new range removes nothing", () => {
    render(
      <RosterPeriodCard
        range={VALID_RANGE}
        importedHolidaysPresent
        onCommit={vi.fn()}
        countRemovals={() => ({ requests: 0, leaveDays: 0 })}
      />,
    );
    fireEvent.change(screen.getByTestId("range-end"), { target: { value: "2026-08-20" } });
    expect(screen.queryByTestId("range-removal-warning")).toBeNull();
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
    // The shared Base UI Switch publishes its state as `data-checked` /
    // `data-unchecked`; the v1 `ns-switch--on` class is gone with the hand-rolled
    // control, so the primitive's own state contract is what is pinned here.
    expect(toggle.getAttribute("data-slot")).toBe("switch");
    expect(toggle.hasAttribute("data-checked")).toBe(true);
    fireEvent.click(screen.getByTestId("range-apply"));
    expect(onCommit).toHaveBeenLastCalledWith(VALID_RANGE, true);
  });

  it("defaults the switch ON with a committed range and imported SG groups present", () => {
    render(<RosterPeriodCard range={VALID_RANGE} importedHolidaysPresent onCommit={vi.fn()} />);

    const toggle = screen.getByTestId("import-toggle");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.hasAttribute("data-checked")).toBe(true);
    // The import list is rendered, honestly reflecting the present groups.
    expect(screen.queryByTestId("import-count")).not.toBeNull();
  });

  it("defaults the switch OFF for a loaded range WITHOUT the SG groups (no false 'N marked')", () => {
    render(
      <RosterPeriodCard range={VALID_RANGE} importedHolidaysPresent={false} onCommit={vi.fn()} />,
    );

    const toggle = screen.getByTestId("import-toggle");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.hasAttribute("data-checked")).toBe(false);
    expect(toggle.hasAttribute("data-unchecked")).toBe(true);
    // No import summary is shown, so nothing implies an import that never happened.
    expect(screen.queryByTestId("import-changes")).toBeNull();
    expect(screen.queryByTestId("import-count")).toBeNull();
  });
});

describe("RosterPeriodCard — holiday data coverage (bead si4j)", () => {
  afterEach(() => setSingaporeHolidays(SINGAPORE_HOLIDAYS));
  const INTO_2028: DateRange = { start: "2027-12-01", end: "2028-01-31" };

  it("warns which year has no holiday data and disables the switch", () => {
    render(<RosterPeriodCard range={INTO_2028} importedHolidaysPresent onCommit={vi.fn()} />);
    expect(screen.getByTestId("import-unsupported").textContent).toBe(
      "No public-holiday data for 2028 yet. Holidays in those dates are not marked.",
    );
    expect(screen.getByTestId("import-toggle")).toHaveAttribute("aria-disabled", "true");
  });

  it("clears the warning when the live list covering 2028 arrives", () => {
    render(<RosterPeriodCard range={INTO_2028} importedHolidaysPresent onCommit={vi.fn()} />);
    act(() =>
      setSingaporeHolidays(
        mergeSingaporeHolidays(
          [{ date: "2028-01-01", name: "New Year's Day", isObserved: false }],
          SINGAPORE_HOLIDAYS,
        ),
      ),
    );
    expect(screen.queryByTestId("import-unsupported")).toBeNull();
    expect(screen.getByTestId("holiday-2028-01-01")).toHaveTextContent("New Year's Day");
  });

  it("shows no warning for a covered range", () => {
    render(<RosterPeriodCard range={VALID_RANGE} importedHolidaysPresent onCommit={vi.fn()} />);
    expect(screen.queryByTestId("import-unsupported")).toBeNull();
  });
});
