// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { CountCardList } from "./count-card-list";
import type { CountCard } from "@/lib/scenario";

// ds1 (P2): a saved contracted-hours card once rendered the RAW half-hour encoding
// in its summary — a 160h contract showed as `x = 320` and its coefficients as
// `LEAVE · 16` — so a ward manager read grid units as hours/shifts. These tests pin
// the human-hours presentation (target `160h`, coefficients `LEAVE · 8h`, matching
// the guided editor's target inputs) and guard that ordinary counts stay raw.

const NOOP_PROPS = {
  onEdit: () => {},
  onDuplicate: () => {},
  onDelete: () => {},
  onMove: () => {},
  onSetDisabled: () => {},
  onReorder: () => {},
  onConvertToContracted: () => {},
  onConvertToGeneric: () => {},
  convertToGenericUid: null,
  onConfirmConvertToGeneric: () => {},
  onCancelConvertToGeneric: () => {},
};

const exactContractedCard: CountCard = {
  uid: "c-exact",
  description: "Full-timer monthly hours",
  person: ["alice"],
  countDates: ["2026-01"],
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

const rangeContractedCard: CountCard = {
  uid: "c-range",
  description: "Part-timer hours band",
  person: ["bob"],
  countDates: ["2026-01"],
  countShiftTypes: ["D"],
  countShiftTypeCoefficients: [["D", 24]],
  expression: ["x >= T", "x <= T"],
  target: [300, 340],
  weight: Infinity,
  tag: "contracted_hours",
  policy: "range",
  unit: "half-hour",
};

const ordinaryCard: CountCard = {
  uid: "ordinary",
  description: "At least five nights",
  person: ["carol"],
  countDates: ["2026-01"],
  countShiftTypes: ["N"],
  countShiftTypeCoefficients: [["N", 2]],
  expression: "x >= T",
  target: 5,
  weight: 3,
};

afterEach(() => {
  cleanup();
});

describe("CountCardList — uncredited-leave saved badge (qq0.23d)", () => {
  // A second marked card, identical body but distinct uid, models a duplicate.
  const exactContractedDup: CountCard = { ...exactContractedCard, uid: "c-exact-dup" };

  it("renders the 'Leave not credited' badge on a marked card whose uid is flagged", () => {
    render(
      <CountCardList
        counts={[exactContractedCard]}
        {...NOOP_PROPS}
        leaveGuardUids={new Set(["c-exact"])}
      />,
    );
    const card = screen.getByTestId("count-card-0");
    expect(within(card).getByTestId("count-leave-warning-badge-0")).toBeTruthy();
    expect(within(card).getByText("Leave not credited")).toBeTruthy();
  });

  it("omits the badge when the card's uid is not flagged", () => {
    render(
      <CountCardList counts={[exactContractedCard]} {...NOOP_PROPS} leaveGuardUids={new Set()} />,
    );
    expect(screen.queryByTestId("count-leave-warning-badge-0")).toBeNull();
    expect(screen.queryByText("Leave not credited")).toBeNull();
  });

  it("never badges an ordinary (unmarked) card even if its uid is flagged", () => {
    render(
      <CountCardList
        counts={[ordinaryCard]}
        {...NOOP_PROPS}
        leaveGuardUids={new Set(["ordinary"])}
      />,
    );
    expect(screen.queryByTestId("count-leave-warning-badge-0")).toBeNull();
  });

  it("follows the flagged uid through a reorder (identity, not index)", () => {
    // Flag only the SECOND card's uid. In [exact, range] it badges card-1.
    const { rerender } = render(
      <CountCardList
        counts={[exactContractedCard, rangeContractedCard]}
        {...NOOP_PROPS}
        leaveGuardUids={new Set(["c-range"])}
      />,
    );
    expect(screen.queryByTestId("count-leave-warning-badge-0")).toBeNull();
    expect(screen.getByTestId("count-leave-warning-badge-1")).toBeTruthy();

    // Reorder to [range, exact] with the SAME uid flagged — the badge moves to card-0.
    rerender(
      <CountCardList
        counts={[rangeContractedCard, exactContractedCard]}
        {...NOOP_PROPS}
        leaveGuardUids={new Set(["c-range"])}
      />,
    );
    expect(screen.getByTestId("count-leave-warning-badge-0")).toBeTruthy();
    expect(screen.queryByTestId("count-leave-warning-badge-1")).toBeNull();
  });

  it("badges each of two duplicate identical marked cards independently by uid", () => {
    render(
      <CountCardList
        counts={[exactContractedCard, exactContractedDup]}
        {...NOOP_PROPS}
        leaveGuardUids={new Set(["c-exact", "c-exact-dup"])}
      />,
    );
    expect(screen.getByTestId("count-leave-warning-badge-0")).toBeTruthy();
    expect(screen.getByTestId("count-leave-warning-badge-1")).toBeTruthy();
  });
});

describe("CountCardList — contracted-hours human-hours summary (ds1)", () => {
  it("renders an exact contracted card's target and coefficients in human hours", () => {
    render(<CountCardList counts={[exactContractedCard]} {...NOOP_PROPS} />);
    const card = screen.getByTestId("count-card-0");

    // Target: `160h`, never the raw `x = 320`.
    expect(within(card).getByText("160h")).toBeTruthy();
    expect(within(card).queryByText(/x = 320/)).toBeNull();
    expect(within(card).queryByText("320")).toBeNull();

    // Coefficients: `LEAVE · 8h` / `D · 12h`, never the raw `LEAVE · 16` / `D · 24`.
    expect(within(card).getByText("LEAVE · 8h")).toBeTruthy();
    expect(within(card).getByText("D · 12h")).toBeTruthy();
    expect(within(card).queryByText("LEAVE · 16")).toBeNull();
    expect(within(card).queryByText("D · 24")).toBeNull();
  });

  it("renders a range contracted card's target as a human-hours span", () => {
    render(<CountCardList counts={[rangeContractedCard]} {...NOOP_PROPS} />);
    const card = screen.getByTestId("count-card-0");

    expect(within(card).getByText("150–170h")).toBeTruthy();
    expect(within(card).queryByText(/x >= 300/)).toBeNull();
    expect(within(card).getByText("D · 12h")).toBeTruthy();
  });

  it("leaves an ordinary (unitless) count card's raw expression and coefficients unchanged", () => {
    render(<CountCardList counts={[ordinaryCard]} {...NOOP_PROPS} />);
    const card = screen.getByTestId("count-card-0");

    // Ordinary counts are NOT half-hour encoded — the raw expression/target and raw
    // coefficient value must render verbatim (no `h` suffix, no hours conversion).
    expect(within(card).getByText("x >= 5")).toBeTruthy();
    expect(within(card).getByText("N · 2")).toBeTruthy();
    expect(within(card).queryByText("2h 30m")).toBeNull();
    expect(within(card).queryByText("1h")).toBeNull();
  });
});
