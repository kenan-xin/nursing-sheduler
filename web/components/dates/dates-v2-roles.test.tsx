// @vitest-environment jsdom
//
// R2a — the Dates route's v2 visual-role contract, asserted at the component
// boundary.
//
// What this file is FOR, and what it deliberately is not. F4's browser matrix
// proves the RESOLVED paint for `/dates` (tone, elevation, radius, contrast,
// coarse targets) in a real Chromium. It cannot prove which CONTRACT produced
// that paint: a hand-authored `bg-panel shadow-well` and the shared `well` role
// compute identically, and the whole point of the re-skin is that this screen
// stops forking its own presentation. So these tests pin the AUTHORITY — the
// surface recipe's roles and the shared primitives' slots — and are
// discriminating precisely where a regression would be invisible downstream:
// swapping a role back to a literal utility, or reintroducing one of the retired
// `.ns-*` v1 controls, fails here while every pixel still looks right.
//
// `DatesScreen` itself is not rendered here (it needs the durable store and the
// router); its page-plane root is pinned in `e2e/dates.spec.ts` against resolved
// computed styles instead.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DateRange } from "@/lib/dates";
import type { UiDateGroup } from "@/lib/scenario";
import { surfaceVariants } from "@/components/ui/surface";
import { DateGroupsCard } from "./date-groups-card";
import { RosterPeriodCard } from "./roster-period-card";

afterEach(() => {
  cleanup();
});

const AUG: DateRange = { start: "2026-08-01", end: "2026-08-31" };
const GROUPS: UiDateGroup[] = [{ id: "SummerRun", members: ["01", "02", "03"] }];

/** Every class the named recipe role emits, so a test never restates a token. */
function roleClasses(...args: Parameters<typeof surfaceVariants>): string[] {
  return surfaceVariants(...args)
    .split(/\s+/)
    .filter(Boolean);
}

function expectRole(element: Element, ...args: Parameters<typeof surfaceVariants>) {
  const classes = element.className.split(/\s+/);
  for (const token of roleClasses(...args)) {
    expect(classes, `${element.getAttribute("data-testid")} → ${token}`).toContain(token);
  }
}

function renderGroups(range: DateRange = AUG) {
  return render(
    <DateGroupsCard
      range={range}
      editableGroups={GROUPS}
      onCreateGroup={vi.fn()}
      onSaveGroup={vi.fn()}
      onDeleteGroup={vi.fn()}
    />,
  );
}

// The v1 controls this ticket retired. Each was a Dates-only fork of something the
// shared layer now owns, so ANY of them reappearing in the rendered tree means the
// screen has drifted back off the shared contract.
const RETIRED_V1_CLASSES = [
  "ns-btn",
  "ns-input",
  "ns-switch",
  "ns-icon-btn",
  "ns-square-btn",
  "ns-quick-pick",
  "ns-day-chip",
  "ns-derived-chip",
  "ns-dg-preview",
  "ns-scope-grids",
];

describe("R2a — roster-period card surface roles", () => {
  it("is a resting L1 card, with the Date-IDs explainer as an inset well", () => {
    render(<RosterPeriodCard range={AUG} importedHolidaysPresent onCommit={vi.fn()} />);

    expectRole(screen.getByTestId("roster-period-card"), {
      role: "surface",
      geometry: "card",
    });

    const explainer = screen.getByTestId("date-id-explainer");
    expect(explainer.getAttribute("data-level")).toBe("well");
    expect(explainer.getAttribute("data-geometry")).toBe("control");
    expectRole(explainer, { role: "well", geometry: "control" });
    // Direction of light is fixed: a well never carries an outer shadow.
    expect(explainer.className).not.toContain("shadow-1");
  });

  it("renders the holiday heading as a FULL-BLEED square band, not a rounded chip", () => {
    render(<RosterPeriodCard range={AUG} importedHolidaysPresent onCommit={vi.fn()} />);

    const list = screen.getByTestId("import-changes");
    // The box rounds and clips; the band inside it must not round.
    expect(list.className).toContain("rounded-control");
    expect(list.className).toContain("overflow-hidden");

    const band = screen.getByTestId("import-count").parentElement!;
    expectRole(band, { role: "band", geometry: "square" });
    expect(band.className).toContain("rounded-none");
    expect(band.className).not.toContain("shadow-well");
  });

  it("drives the import toggle through the shared Switch, not a hand-rolled button", () => {
    render(<RosterPeriodCard range={AUG} importedHolidaysPresent onCommit={vi.fn()} />);

    const toggle = screen.getByTestId("import-toggle");
    expect(toggle.getAttribute("data-slot")).toBe("switch");
    expect(toggle.getAttribute("role")).toBe("switch");
    // The PRESSABLE root is what grows on a coarse pointer — not an overlapping
    // pseudo-element hitbox (v2 technical plan T8).
    expect(toggle.className).toContain("pointer-coarse:size-touch");
  });

  it("uses the shared field primitives for both endpoints, each explicitly labelled", () => {
    render(<RosterPeriodCard range={AUG} importedHolidaysPresent onCommit={vi.fn()} />);

    for (const [testId, name] of [
      ["range-start", "Start date"],
      ["range-end", "End date"],
    ] as const) {
      const field = screen.getByTestId(testId);
      expect(field.getAttribute("data-slot")).toBe("input");
      expect(field.className).toContain("rounded-control");
      expect(field.className).toContain("h-control");
      expect(field.className).toContain("pointer-coarse:min-h-touch");
      // The <label for> association survives the swap away from a wrapping label.
      expect(screen.getByLabelText(name)).toBe(field);
    }
  });

  it("authors no retired v1 control class", () => {
    const { container } = render(
      <RosterPeriodCard range={AUG} importedHolidaysPresent onCommit={vi.fn()} />,
    );
    for (const cls of RETIRED_V1_CLASSES) {
      expect(container.querySelectorAll(`[class*="${cls}"]`), cls).toHaveLength(0);
    }
  });
});

describe("R2a — date-groups card surface roles", () => {
  it("is a resting L1 card whose group rows are inset wells", () => {
    renderGroups();

    expectRole(screen.getByTestId("date-groups-panel"), { role: "surface", geometry: "card" });
    expectRole(screen.getByTestId("editable-group-SummerRun"), {
      role: "well",
      geometry: "control",
    });
  });

  it("promotes a PREVIEWED row from the well to the shared selected role", () => {
    renderGroups();

    const row = () => screen.getByTestId("editable-group-SummerRun");
    expect(row().className).toContain("bg-panel");

    fireEvent.click(screen.getByTestId("editable-group-preview-SummerRun"));

    expectRole(row(), { role: "selected", geometry: "control" });
    // The selection language is the recipe's brand edge and lift — NOT a
    // `--brandtint` wash, which v2 reserves for the selection marks themselves.
    expect(row().className).toContain("border-brand");
    expect(row().className).not.toContain("bg-brandtint");
  });

  it("gives the sticky preview panel the selected role and clips it to the card radius", () => {
    renderGroups();
    fireEvent.click(screen.getByTestId("editable-group-preview-SummerRun"));

    const panel = screen.getByTestId("date-group-preview");
    expectRole(panel, { role: "selected", geometry: "card" });
    expect(panel.className).toContain("overflow-hidden");
    // It sticks below the shell's own sticky top bar and under its z-30.
    expect(panel.className).toContain("sticky");
    expect(panel.className).toContain("top-14");
    expect(panel.className).toContain("z-20");
  });

  it("renders the open editor on the selected role, with a shared field", () => {
    renderGroups();
    fireEvent.click(screen.getByTestId("editable-group-edit-SummerRun"));

    expectRole(screen.getByTestId("date-group-editor-SummerRun"), {
      role: "selected",
      geometry: "control",
    });

    const name = screen.getByTestId("date-group-name");
    expect(name.getAttribute("data-slot")).toBe("input");
    expect(screen.getByLabelText("Group name")).toBe(name);
  });

  it("seats the day-scope picker in an inset well tray", () => {
    renderGroups();
    fireEvent.click(screen.getByTestId("editable-group-edit-SummerRun"));

    const tray = screen.getByTestId("date-scope-picker").querySelector("[data-slot='surface']")!;
    expect(tray.getAttribute("data-level")).toBe("well");
    expect(tray.getAttribute("data-geometry")).toBe("control");
  });

  it("makes every action a shared Button — including the three quick-picks", () => {
    renderGroups();
    fireEvent.click(screen.getByTestId("editable-group-edit-SummerRun"));

    for (const testId of [
      "date-group-add",
      "date-group-save",
      "date-group-cancel",
      "date-group-delete",
      "date-scope-picker-weekends",
      "date-scope-picker-weekdays",
      "date-scope-picker-clear",
    ]) {
      const button = screen.getByTestId(testId);
      expect(button.getAttribute("data-slot"), testId).toBe("button");
      expect(button.className, testId).toContain("rounded-pill");
      // A real 44x44 minimum on the control itself, on both axes.
      expect(button.className, testId).toContain("pointer-coarse:min-h-touch");
      expect(button.className, testId).toContain("pointer-coarse:min-w-touch");
    }
  });

  it("marks the destructive row and editor actions as outlines, never a solid fill", () => {
    renderGroups();
    const rowDelete = screen.getByTestId("editable-group-delete-SummerRun");
    expect(rowDelete.className).toContain("border-error");
    expect(rowDelete.className).toContain("text-errorink");
    expect(rowDelete.className).not.toContain("bg-fill-error");
  });

  it("toggles the derived preview chip between the brand fill and L1, with aria-pressed", () => {
    renderGroups();

    const chip = () => screen.getByTestId("derived-group-WEEKEND");
    expect(chip().getAttribute("data-slot")).toBe("button");
    expect(chip().getAttribute("aria-pressed")).toBe("false");
    expect(chip().className).toContain("bg-surface");

    fireEvent.click(chip());

    expect(chip().getAttribute("aria-pressed")).toBe("true");
    expect(chip().className).toContain("bg-brand");
    // Text on a solid semantic fill takes the paired ON-colour, never a
    // hand-picked foreground (DESIGN.md §6).
    expect(chip().className).toContain("text-onbrand");
  });

  it("renders member day chips as outlined badges on the panel row, not a second panel plane", () => {
    renderGroups();

    const row = screen.getByTestId("editable-group-SummerRun");
    const badges = row.querySelectorAll("[data-slot='badge']");
    expect(badges.length).toBeGreaterThan(0);
    for (const badge of Array.from(badges)) {
      expect(badge.className).toContain("rounded-chip");
      expect(badge.className).toContain("bg-transparent");
      expect(badge.className).toContain("normal-case");
    }
  });

  it("exposes a group's description through the focusable InfoTip, not a hover-only icon", () => {
    render(
      <DateGroupsCard
        range={AUG}
        editableGroups={[{ id: "SummerRun", members: ["01"], description: "Peak cover" }]}
        onCreateGroup={vi.fn()}
        onSaveGroup={vi.fn()}
        onDeleteGroup={vi.fn()}
      />,
    );

    const tip = screen.getByRole("button", { name: "SummerRun: Peak cover" });
    expect(tip.tagName).toBe("BUTTON");
    expect(tip.className).toContain("pointer-coarse:size-touch");
  });

  it("authors no retired v1 control class, editor and preview open", () => {
    const { container } = renderGroups();
    fireEvent.click(screen.getByTestId("editable-group-preview-SummerRun"));
    fireEvent.click(screen.getByTestId("date-group-add"));

    for (const cls of RETIRED_V1_CLASSES) {
      expect(container.querySelectorAll(`[class*="${cls}"]`), cls).toHaveLength(0);
    }
  });
});
