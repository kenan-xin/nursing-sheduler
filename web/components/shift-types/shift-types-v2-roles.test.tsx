// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { RequirementCard, ScenarioUiState } from "@/lib/scenario";
import {
  drainScenarioPersist,
  resetToNewScenario,
  useHotStore,
  useScenarioStore,
} from "@/lib/store";
import { surfaceVariants } from "@/components/ui/surface";
import { buttonVariants } from "@/components/ui/button";
import { ShiftTypeGrid } from "./shift-type-grid";

// R2c — which CONTRACT authored each surface on /shift-types.
//
// This suite is deliberately complementary to `e2e/shift-types.spec.ts`, and
// neither is sufficient alone. A hand-authored `bg-surface border-line shadow-1`
// box and the shared `surface` role compute IDENTICALLY in a browser, so a
// regression back off the shared recipe is invisible to a resolved-paint check;
// only a source/render-level check catches it. Conversely nothing here proves a
// single resolved pixel — jsdom applies no stylesheet — so every geometry, tone
// and elevation claim is measured in the E2E suite instead.
//
// Assertions never restate a token. They ask the recipe what it emits, so if the
// ladder's definition of a role changes, this suite follows it rather than
// pinning yesterday's class list.

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/shift-types",
}));

/** Every class the named recipe role emits, so a test never restates a token. */
function roleClasses(...args: Parameters<typeof surfaceVariants>): string[] {
  return surfaceVariants(...args)
    .split(/\s+/)
    .filter(Boolean);
}

function expectRole(element: Element, ...args: Parameters<typeof surfaceVariants>) {
  const classes = element.className.split(/\s+/);
  for (const token of roleClasses(...args)) {
    expect(
      classes,
      `${element.getAttribute("data-testid") ?? element.tagName} → ${token}`,
    ).toContain(token);
  }
}

/**
 * The class list is CLOSED: exactly the declared layout utilities plus whatever
 * the recipe emitted, and nothing else. Token PRESENCE alone would let a call
 * site smuggle an extra `bg-*`, `shadow-*` or `rounded-*` in beside the role and
 * still pass — which is precisely the caller-side visual override the shared
 * authority exists to remove. Compared as a SET, so a reordering is not a
 * failure but an addition always is.
 */
function expectClosedClassList(
  element: Element,
  layout: string[],
  ...args: Parameters<typeof surfaceVariants>
) {
  const actual = [...new Set(element.className.split(/\s+/).filter(Boolean))].sort();
  const allowed = [...new Set([...layout, ...roleClasses(...args)])].sort();
  expect(actual, `${element.getAttribute("data-testid") ?? element.tagName} class list`).toEqual(
    allowed,
  );
}

function expectNotRole(element: Element, ...args: Parameters<typeof surfaceVariants>) {
  const classes = element.className.split(/\s+/);
  const emitted = roleClasses(...args);
  expect(
    emitted.every((token) => classes.includes(token)),
    `${element.getAttribute("data-testid") ?? element.tagName} must NOT carry ${emitted.join(" ")}`,
  ).toBe(false);
}

function seed(patch: Partial<ScenarioUiState>) {
  act(() => {
    useScenarioStore.getState().mutateScenario(patch);
  });
}

function seedRequirements(cards: RequirementCard[], patch: Partial<ScenarioUiState> = {}) {
  seed({
    ...patch,
    cardsByKind: { ...useScenarioStore.getState().cardsByKind, requirements: cards },
  });
}

function baseline(overrides: Partial<RequirementCard> = {}): RequirementCard {
  return {
    uid: "req-day",
    shiftType: ["Day"],
    requiredNumPeople: 2,
    qualifiedPeople: ["ALL"],
    date: ["ALL"],
    weight: -50,
    ...overrides,
  };
}

const DAY = "string:Day";
const NIGHT = "string:Night";

beforeEach(async () => {
  vi.clearAllMocks();
  await resetToNewScenario(useScenarioStore, useHotStore);
  await drainScenarioPersist(useScenarioStore);
  seed({ shifts: [], shiftGroups: [] });
});

afterEach(() => {
  cleanup();
});

describe("R2c surface ladder — authored by the shared recipe, not by hand", () => {
  it("puts the screen root on the L0 page plane through the Surface adapter", () => {
    render(<ShiftTypeGrid />);
    const root = screen.getByTestId("screen");

    // The adapter's own marker: a hand-rolled `bg-bg` div would satisfy the paint
    // check in a browser but carries neither slot nor level.
    expect(root).toHaveAttribute("data-slot", "surface");
    expect(root).toHaveAttribute("data-level", "page");
    expect(root).toHaveAttribute("data-geometry", "square");
    expectRole(root, { role: "page", geometry: "square" });

    // F4's manifest row for /shift-types resolves `[data-testid="screen"]` as the
    // page role; the screen marker must stay on the surface that claims it.
    expect(root).toHaveAttribute("data-screen", "Shifts");
  });

  it("renders a resting shift card as an L1 surface at the card radius", () => {
    seed({ shifts: [{ id: "Day", startTime: "08:00", endTime: "16:00", durationMinutes: 480 }] });
    render(<ShiftTypeGrid />);

    const card = screen.getByTestId(`shift-card-${DAY}`);
    expectRole(card, { role: "surface", geometry: "card" });
    // Draggable while no editor is open — the affordance lives in the recipe, so
    // a call site cannot author `cursor-grab` on its own.
    expectRole(card, { interaction: "grabbable" });
    // 18px card padding on the baked 0.9 grid (5 × 0.25rem × 0.9), not an
    // arbitrary `p-[18px]`.
    expect(card.className.split(/\s+/)).toContain("p-5");
    // Nothing else. No stray tone, elevation or radius rides along beside the role.
    expectClosedClassList(card, ["flex", "flex-col", "gap-3", "p-5"], {
      role: "surface",
      geometry: "card",
      interaction: "grabbable",
    });
  });

  it("renders the reserved OFF/LEAVE tiles as L1 cards, locked by badge not by tone", () => {
    render(<ShiftTypeGrid />);

    for (const id of ["OFF", "LEAVE"]) {
      const tile = screen.getByTestId(`synthetic-${id}`);
      expectRole(tile, { role: "surface", geometry: "card" });
      // Not a well: a `--panel` tile RECEDES in light mode and RISES in dark
      // (dark `--panel` is lighter than dark `--bg`), so tone cannot carry
      // "locked" across both themes. The AUTO badge and the absent action row do.
      expectNotRole(tile, { role: "well", geometry: "card" });
      expect(within(tile).getByText("Auto")).toBeInTheDocument();
      expect(within(tile).queryByRole("button")).toBeNull();
    }
  });

  it("renders every icon tile as an inset well on the chip radius", () => {
    seed({ shifts: [{ id: "Day" }] });
    render(<ShiftTypeGrid />);

    const tiles = [
      screen.getByTestId(`shift-card-${DAY}`).querySelector('[data-slot="surface-tile"]'),
      ...Array.from(document.querySelectorAll('[data-slot="surface-tile"]')),
    ];
    // Fall back to a structural sweep: the tiles are unlabelled marks, so they are
    // found by the role they claim rather than by a testid.
    const wells = Array.from(document.querySelectorAll("div")).filter((el) =>
      roleClasses({ role: "well", geometry: "chip" }).every((token) =>
        el.className.split(/\s+/).includes(token),
      ),
    );
    // One per shift card + one per reserved tile.
    expect(wells.length).toBeGreaterThanOrEqual(3);
    for (const well of wells) {
      // A well never takes an outer shadow (DESIGN.md §4 rule 1).
      expect(well.className).not.toMatch(/\bshadow-[123]\b/);
      expect(well.className.split(/\s+/)).toContain("size-control-lg");
    }
    expect(tiles.length).toBeGreaterThan(0);
  });

  it("lifts the open editor to the `selected` role instead of washing it in brandtint", () => {
    seed({ shifts: [{ id: "Day" }] });
    render(<ShiftTypeGrid />);
    fireEvent.click(screen.getByTestId(`shift-edit-${DAY}`));

    const form = screen.getByTestId(`shift-edit-form-${DAY}`);
    expectRole(form, { role: "selected", geometry: "card" });
    // `--brandtint` is reserved for selection MARKS (DESIGN.md §6). v1 washed the
    // whole editor in `bg-brandtint/40`, which the brand-inked eyebrow and the
    // brand chips inside it then sank into.
    expect(form.className).not.toMatch(/bg-brandtint/);
    expectClosedClassList(form, ["flex", "flex-col", "gap-4", "p-5"], {
      role: "selected",
      geometry: "card",
    });
  });

  it("marks a drop candidate with the shared drop-target role, never a raw inset shadow", () => {
    seed({ shifts: [{ id: "Day" }, { id: "Night" }] });
    render(<ShiftTypeGrid />);

    const source = screen.getByTestId(`shift-card-${DAY}`);
    const target = screen.getByTestId(`shift-card-${NIGHT}`);

    fireEvent.dragStart(source);
    fireEvent.dragOver(target);

    expectRole(target, { role: "drop-target", geometry: "card" });
    expectRole(source, { interaction: "dragging" });
    // The retired v1 mark. An arbitrary elevation is rejected outright by the
    // static provenance gate even when its value matches a canonical token.
    expect(document.body.innerHTML).not.toContain("shadow-[inset");
  });

  it("renders the read-only and numeric staffing boxes as inset wells", () => {
    seedRequirements([baseline({ qualifiedPeople: ["Seniors"] })], {
      shifts: [{ id: "Day" }],
      rangeStart: "2026-07-01",
      rangeEnd: "2026-07-07",
    });
    render(<ShiftTypeGrid />);
    fireEvent.click(screen.getByTestId(`shift-edit-${DAY}`));

    expectRole(screen.getByTestId(`shift-edit-${DAY}-staffing-readonly`), {
      role: "well",
      geometry: "control",
    });
  });

  it("renders the numeric-code staffing note as an inset well", () => {
    seed({ shifts: [{ id: 7 }] });
    render(<ShiftTypeGrid />);
    fireEvent.click(screen.getByTestId("shift-edit-number:7"));

    expectRole(screen.getByTestId("shift-edit-number:7-staffing-numeric"), {
      role: "well",
      geometry: "control",
    });
  });
});

describe("R2c primitive adoption — shared components, not caller-side overrides", () => {
  it("uses the shared destructive-outline Button for Delete", () => {
    seed({ shifts: [{ id: "Day" }] });
    render(<ShiftTypeGrid />);

    const del = screen.getByTestId(`shift-delete-${DAY}`);
    expect(del).toHaveAttribute("data-slot", "button");
    for (const token of buttonVariants({ variant: "destructive-outline" }).split(/\s+/)) {
      expect(del.className.split(/\s+/)).toContain(token);
    }
    // v1 wore `variant="outline"` and hand-painted it — exactly the caller-owned
    // visual override the shared contract exists to remove.
    expect(del.className).not.toMatch(/hover:bg-errortint\b.*\btext-error\b|\btext-error\b/);
  });

  it("renders the duration readout through the shared Badge on the chip radius", () => {
    seed({ shifts: [{ id: "Day", durationMinutes: 510 }] });
    render(<ShiftTypeGrid />);

    const badge = screen.getByTestId(`shift-dur-${DAY}`);
    expect(badge).toHaveAttribute("data-slot", "badge");
    expect(badge.className.split(/\s+/)).toContain("rounded-chip");
    // Authored data reads as the user set it — not uppercased like a status eyebrow.
    expect(badge.className.split(/\s+/)).toContain("normal-case");
    expect(badge).toHaveTextContent("8h 30m");
  });

  it("leaves the Save button's visuals entirely to the Button recipe", () => {
    render(<ShiftTypeGrid />);
    fireEvent.click(screen.getByTestId("add-shift-toggle"));

    const save = screen.getByTestId("shift-add-save");
    expect(save.className.split(/\s+/)).toContain("rounded-pill");
    // v1 shipped `className="border border-transparent"` to hold the primary
    // button's height against an outlined sibling; v2's absolute control sizes
    // make the shim dead weight.
    expect(save.className).not.toMatch(/border-transparent/);
  });
});

describe("R2c typography and status — the named rules", () => {
  it("runs the page heading at the display step with the negative-tracking rule", () => {
    render(<ShiftTypeGrid />);
    const heading = screen.getByRole("heading", { level: 1 });
    const classes = heading.className.split(/\s+/);

    expect(classes).toContain("text-display");
    expect(classes).toContain("font-bold");
    expect(classes).toContain("tracking-[-0.015em]");
    // v1's `tracking-tight` is -0.025em, and the rule is unconditional at -0.015em.
    expect(classes).not.toContain("tracking-tight");
  });

  it("tracks every uppercase label at +0.03em and never at a bespoke value", () => {
    seed({ shifts: [{ id: "Day" }] });
    render(<ShiftTypeGrid />);
    fireEvent.click(screen.getByTestId(`shift-edit-${DAY}`));

    const uppercase = Array.from(document.querySelectorAll("[class*='uppercase']"));
    expect(uppercase.length).toBeGreaterThan(0);
    for (const el of uppercase) {
      const bespoke = el.className.match(/tracking-\[([^\]]+)\]/);
      if (bespoke && !el.className.includes("font-mono")) {
        expect(
          ["0.03em", "-0.015em"],
          `${el.textContent?.trim().slice(0, 24)} tracks at ${bespoke[1]}`,
        ).toContain(bespoke[1]);
      }
    }
  });

  it("pairs the preferred-collapse warning's tint with its matching ink and border", () => {
    seedRequirements([baseline({ preferredNumPeople: 3 })], {
      shifts: [{ id: "Day" }],
      rangeStart: "2026-07-01",
      rangeEnd: "2026-07-07",
    });
    render(<ShiftTypeGrid />);
    fireEvent.click(screen.getByTestId(`shift-edit-${DAY}`));
    fireEvent.change(screen.getByTestId(`shift-edit-${DAY}-preferred`), { target: { value: "" } });

    const notice = screen.getByTestId(`shift-edit-${DAY}-preferred-collapse`);
    const classes = notice.className.split(/\s+/);
    expect(classes).toContain("bg-warntint");
    expect(classes).toContain("border-warn");
    // The DEEPEST tier on its own tint (DESIGN.md §2). v1 used plain `--ink`,
    // which reads as ordinary copy that happens to sit on amber.
    expect(classes).toContain("text-warnink");
    expect(classes).toContain("rounded-control");
    // Redundant Signal Rule: the copy says what will happen, so colour is never
    // the only carrier.
    expect(notice).toHaveTextContent(/cleared/i);
  });

  it("pairs the save-failure notice's tint with its matching ink and border", () => {
    seedRequirements([baseline()], {
      shifts: [{ id: "Day" }],
      rangeStart: "2026-07-01",
      rangeEnd: "2026-07-07",
    });
    render(<ShiftTypeGrid />);
    fireEvent.click(screen.getByTestId(`shift-edit-${DAY}`));
    // An out-of-range minimum is rejected inside the save path and surfaces
    // on-card (the button stays enabled, so this is the notice's real route).
    fireEvent.change(screen.getByTestId(`shift-edit-${DAY}-required`), { target: { value: "-1" } });
    fireEvent.click(screen.getByTestId(`shift-edit-${DAY}-save`));

    const alert = screen.getByTestId(`shift-edit-${DAY}-save-error`);
    const classes = alert.className.split(/\s+/);
    expect(classes).toContain("bg-errortint");
    expect(classes).toContain("border-error");
    expect(classes).toContain("text-errorink");
    expect(classes).toContain("rounded-control");
    expect(alert).toHaveAttribute("role", "alert");
  });

  it("never leaves functional copy on --faint, and never authors a v1 escape", () => {
    seed({
      shifts: [{ id: "Day", startTime: "19:00", endTime: "07:00", durationMinutes: 720 }],
      shiftGroups: [{ id: "Working", members: ["Day"] }],
    });
    render(<ShiftTypeGrid />);
    fireEvent.click(screen.getByTestId(`shift-edit-${DAY}`));

    const html = document.body.innerHTML;
    // Retired v1 presentation, swept across the whole rendered tree (resting,
    // reserved, editing and grouped) rather than one element at a time.
    for (const retired of [
      "p-[18px]",
      "size-[42px]",
      "bg-brandtint/40",
      "shadow-[",
      "font-extrabold",
      "tracking-tight",
      "tracking-[0.06em]",
      "border-transparent",
    ]) {
      expect(html, `retired v1 presentation still rendered: ${retired}`).not.toContain(retired);
    }

    // `--faint` is legitimate BEHIND a variant — the shared Input's
    // `placeholder:text-faint` is exactly what the token is for. What R2c must
    // not do is leave functional copy on it (DESIGN.md §2: faint is disabled
    // affordances and empty-cell marks only), so the bare utility is what is
    // swept, not the substring.
    const bareFaint = Array.from(document.querySelectorAll("[class]"))
      .flatMap((el) => (el.getAttribute("class") ?? "").split(/\s+/))
      .filter((token) => token === "text-faint");
    expect(bareFaint).toEqual([]);
  });
});

// The fixed eight-entry shift ramp (DESIGN.md §2 "Shift colour palette"). Its
// contract is negative on this route: it stays LITERAL data-mark colour in
// whatever screen eventually draws roster chips, never becomes a theme-token
// family, and never varies by theme. Nothing in the shipped app owns it yet, so
// the only truthful coverage is that it has not started leaking into the token
// authority or into this route's sources — which is exactly the first move of
// the drift the decision forbids. `e2e/shift-types.spec.ts` completes the pair
// by proving no element on the route PAINTS one of these in either theme.
const SHIFT_PALETTE = [
  "#f8e2b8",
  "#7a5310",
  "#d4a038",
  "#f6dbcd",
  "#9a4726",
  "#cf7049",
  "#e4ecd0",
  "#586a22",
  "#8fa243",
  "#d8e0f2",
  "#374777",
  "#6274ad",
  "#e9dbf0",
  "#653f8e",
  "#9670bd",
  "#d3e9e3",
  "#1b6a5d",
  "#3d9587",
  "#f7dae2",
  "#9a3153",
  "#c66184",
  "#2b2733",
  "#ece6f2",
  "#5c5468",
];

describe("R2c accessibility — the bounded quick wins, per the ratified priority", () => {
  it("exposes the card grid as a NAMED region", () => {
    seed({ shifts: [{ id: "Day" }] });
    render(<ShiftTypeGrid />);

    // An unnamed <section> is not a region at all, so the grid was unreachable by
    // landmark navigation and indistinguishable from the Shift groups card.
    expect(screen.getByRole("region", { name: "Shift types" })).toBe(
      screen.getByTestId("shift-grid"),
    );
  });

  it("names the per-card actions by the shift they act on, keeping the visible label", () => {
    seed({ shifts: [{ id: "Day" }, { id: "Night" }] });
    render(<ShiftTypeGrid />);

    for (const id of ["Day", "Night"]) {
      for (const verb of ["Edit", "Delete", "Move"]) {
        const pattern = verb === "Move" ? new RegExp(`^Move ${id} (up|down)$`) : `${verb} ${id}`;
        const matches = screen.getAllByRole("button", { name: pattern });
        expect(matches.length, `${verb} ${id}`).toBeGreaterThan(0);
        // WCAG 2.5.3 Label in Name: the visible word stays inside the
        // accessible name, so speech input still reaches the control.
        for (const button of matches) {
          expect(button.getAttribute("aria-label")).toContain(verb);
        }
      }
    }
  });
});

describe("the fixed shift data palette stays out of the token authority", () => {
  const webRoot = resolve(__dirname, "..", "..");
  const read = (relPath: string) => readFileSync(resolve(webRoot, relPath), "utf8").toLowerCase();

  it("registers none of the eight entries as a CSS custom property", () => {
    const css = read("app/globals.css");
    // Guard the premise: a path that silently read the wrong file would report a
    // clean palette for exactly the wrong reason.
    expect(css).toContain("--r-card");
    const leaked = SHIFT_PALETTE.filter((hex) => css.includes(hex));
    expect(leaked, "a shift data-mark colour has become a theme token").toEqual([]);
  });

  it("is not authored anywhere in the R2c-owned sources", () => {
    const sources = [
      "app/(app)/shift-types/page.tsx",
      "components/shift-types/shift-type-grid.tsx",
      "components/shift-types/shift-types-descriptor.ts",
      "components/shift-types/save-shift-card.ts",
      "components/entity-editor/working-time-fields.tsx",
    ].map(read);
    expect(sources).toHaveLength(5);
    for (const source of sources) {
      const leaked = SHIFT_PALETTE.filter((hex) => source.includes(hex));
      expect(leaked, "a shift data-mark colour is authored on the route").toEqual([]);
    }
  });
});
