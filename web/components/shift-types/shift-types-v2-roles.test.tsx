// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { RequirementCard, ScenarioUiState } from "@/lib/scenario";
import { useScenarioStore, scenarioCommands } from "@/lib/store";
import { cn } from "@/lib/utils";
import { surfaceVariants } from "@/components/ui/surface";
import { buttonVariants } from "@/components/ui/button";
import { ShiftTypeGrid } from "./shift-type-grid";
import { resetScenarioForTest, drainScenarioCommands } from "@/lib/store/test-authority";

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
//
// WHAT CHANGED (custom-AST ticket 3). This file reads NO files. It used to end with a
// six-read block that checked the fixed shift data palette against `app/globals.css` and
// against five named production sources. The reader ledger grants this file no filesystem
// exception, and both halves had better homes: the CSS half moved to `app/design-system.test.ts`,
// which owns the token authority and keeps the audited `globals.css` reader; the five
// production-source scans are the `authored-color-literal(-tsx)` ast-grep rule, which
// rejects ANY authored colour across `app/**` and `components/**` -- strictly more than
// twenty-four specific hexes in five specific files, and enforced on every lint run rather
// than only when this suite happens to execute.

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

async function seed(patch: Partial<ScenarioUiState>) {
  await act(async () => {
    await scenarioCommands.mutate(patch);
  });
}

async function seedRequirements(cards: RequirementCard[], patch: Partial<ScenarioUiState> = {}) {
  await seed({
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
  await resetScenarioForTest();
  await drainScenarioCommands();
  await seed({ shifts: [], shiftGroups: [] });
});

afterEach(async () => {
  cleanup();
});

describe("R2c surface ladder — authored by the shared recipe, not by hand", () => {
  it("puts the screen root on the L0 page plane through the Surface adapter", async () => {
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

  it("renders a resting shift card as an L1 surface at the card radius", async () => {
    await seed({
      shifts: [{ id: "Day", startTime: "08:00", endTime: "16:00", durationMinutes: 480 }],
    });
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

  it("renders the reserved OFF/LEAVE tiles as a QUIET L1 — line2 hairline, no elevation", async () => {
    render(<ShiftTypeGrid />);

    for (const id of ["OFF", "LEAVE"]) {
      const tile = screen.getByTestId(`synthetic-${id}`);
      const classes = tile.className.split(/\s+/);
      // The prototype's own treatment, measured in Chromium: the surface plane
      // with the QUIETER hairline and no cast, so the tile reads inert beside
      // authorable cards that carry `--line` + `--sh-1`.
      expect(classes).toContain("bg-surface");
      expect(classes).toContain("border-line2");
      expect(classes).toContain("rounded-card");
      expect(classes).not.toContain("border-line");
      // No elevation at all — this is the half that reads as "not yours".
      expect(tile.className).not.toMatch(/\bshadow-/);
      // And deliberately NOT the shared `surface` role, whose `--line` border and
      // `--sh-1` are fixed and would make it identical to an editable card.
      expectNotRole(tile, { role: "surface", geometry: "card" });
      // Nor the inset-hairline tuple its own icon tile wears. The cold review of
      // `57ce7b6` adjudicated this composition as deliberately OFF the recipe —
      // no role emits `--surface` + a `--line2` hairline + no elevation — and the
      // deleted analyzer pinned it so a later reader would not "finish the job".
      expectNotRole(tile, { role: "well", geometry: "control", emphasis: "hairline" });
      // It may not smuggle the composition back in through inline style either:
      // React's `style` outranks every class, so an empty style attribute is the
      // whole claim rather than a per-property denylist.
      expect(tile.getAttribute("style"), "the reserved tile owns nothing inline").toBeNull();
      expect(within(tile).getByText("Auto")).toBeInTheDocument();
      expect(within(tile).queryByRole("button")).toBeNull();
    }
  });

  it("renders every icon tile through the shared well/control/hairline tuple at 42px", async () => {
    await seed({ shifts: [{ id: "Day" }] });
    render(<ShiftTypeGrid />);

    const tiles = Array.from(
      document.querySelectorAll('[data-slot="shift-tile"]'),
    ) as HTMLElement[];
    // One per shift card + one per reserved tile.
    expect(tiles.length).toBeGreaterThanOrEqual(3);

    for (const tile of tiles) {
      // The class list is CLOSED over the recipe's output plus the declared
      // layout utilities — asked of the recipe, never restated, so if the tuple's
      // definition changes this follows it.
      expectClosedClassList(tile, ["flex", "flex-none", "items-center", "justify-center"], {
        role: "well",
        geometry: "control",
        emphasis: "hairline",
      });
      // The prototype's 42px has no token, so it is a style rather than an
      // arbitrary utility the recipe consumer's className would reject.
      expect(tile.style.width).toBe("42px");
      expect(tile.style.height).toBe("42px");
      // Direction of light is fixed: inset only, never an outer cast.
      expect(tile.className).not.toMatch(/\bshadow-[123]\b/);
    }
  });

  // -------------------------------------------------------------------------
  // THE GOVERNED-NODE CENSUS (custom-AST ticket 5).
  //
  // The deleted `inset-hairline-ownership.test.ts` analyzer opened with a PREMISE
  // GUARD — "exactly 3 nodes carry `data-slot="shift-tile"` in shift-type-grid.tsx,
  // exactly 1 carries `-duration` in working-time-fields.tsx" — so that a renamed
  // attribute or a dropped tile failed loudly instead of letting the per-node
  // assertions pass over an empty set. `components/ui/inset-hairline-box.test.tsx`
  // proves what the two components EMIT; this proves they are actually MOUNTED, at
  // every governed site, in the states that render them.
  // -------------------------------------------------------------------------
  it("mounts an inset-hairline box at every governed site, in the state that renders it", async () => {
    await seed({ shifts: [{ id: "Day" }] });
    render(<ShiftTypeGrid />);

    // Resting state: a tile inside each reserved day-state card, and one inside
    // the authorable shift card.
    for (const testId of ["synthetic-OFF", "synthetic-LEAVE", `shift-card-${DAY}`]) {
      const host = screen.getByTestId(testId);
      expect(
        host.querySelectorAll('[data-slot="shift-tile"]'),
        `${testId} must mount exactly one icon tile`,
      ).toHaveLength(1);
    }
    expect(document.querySelectorAll('[data-slot="shift-tile"]')).toHaveLength(3);

    // Editing state: the open editor's own header tile, plus the working-time
    // readout — the fourth governed site, and the one that lives in a different
    // file. Neither exists until the editor is open, which is why the resting
    // census above cannot stand in for it.
    fireEvent.click(screen.getByTestId(`shift-edit-${DAY}`));
    const form = screen.getByTestId(`shift-edit-form-${DAY}`);
    expect(form.querySelectorAll('[data-slot="shift-tile"]')).toHaveLength(1);

    const readout = screen.getByTestId(`shift-edit-${DAY}-duration`);
    expect(readout).toHaveAttribute("data-slot", "inset-hairline-readout");
    expectClosedClassList(
      readout,
      [
        "flex",
        "items-center",
        "gap-1.5",
        "overflow-hidden",
        "px-2.5",
        "pointer-coarse:min-h-touch",
      ],
      { role: "well", geometry: "control", emphasis: "hairline" },
    );
    expect(readout.style.height).toBe("var(--ctl)");
  });

  // A CONVERSE was deliberately NOT added here: "no other element on this route
  // may wear the tuple". It is not one of the deleted analyzer's families — that
  // analyzer governed four named nodes and said nothing about a fifth surface —
  // and it is false of correct code: `synthetic-ALL` and every custom group row
  // in the shared groups section are legitimate `well/control/hairline` surfaces
  // reached through the same authority. A rendered check cannot separate a
  // legitimate direct `surfaceVariants(...)` consumer from a raw reimplementation
  // (both emit the same bytes), so the honest owner of that direction is the
  // static half: `inset-hairline-box-authority` inside the owner file, and
  // ticket 4's `surface-consumer-classname` / `surface-recipe-*-visual` rules
  // everywhere else.

  it("lifts the open editor to the `selected` role instead of washing it in brandtint", async () => {
    await seed({ shifts: [{ id: "Day" }] });
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

  it("marks a drop candidate with the shared drop-target role, never a raw inset shadow", async () => {
    await seed({ shifts: [{ id: "Day" }, { id: "Night" }] });
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

  it("renders the read-only and numeric staffing boxes as inset wells", async () => {
    await seedRequirements([baseline({ qualifiedPeople: ["Seniors"] })], {
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

  it("renders the numeric-code staffing note as an inset well", async () => {
    await seed({ shifts: [{ id: 7 }] });
    render(<ShiftTypeGrid />);
    fireEvent.click(screen.getByTestId("shift-edit-number:7"));

    expectRole(screen.getByTestId("shift-edit-number:7-staffing-numeric"), {
      role: "well",
      geometry: "control",
    });
  });
});

describe("R2c primitive adoption — shared components, not caller-side overrides", () => {
  it("uses the shared destructive-outline Button for Delete", async () => {
    await seed({ shifts: [{ id: "Day" }] });
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

  it("renders the duration readout through the shared Badge on the chip radius", async () => {
    await seed({ shifts: [{ id: "Day", durationMinutes: 510 }] });
    render(<ShiftTypeGrid />);

    const badge = screen.getByTestId(`shift-dur-${DAY}`);
    expect(badge).toHaveAttribute("data-slot", "badge");
    expect(badge.className.split(/\s+/)).toContain("rounded-chip");
    // Authored data reads as the user set it — not uppercased like a status eyebrow.
    expect(badge.className.split(/\s+/)).toContain("normal-case");
    expect(badge).toHaveTextContent("8h 30m");
  });

  it("renders Continue to rules as a real guarded anchor wearing the Button recipe", async () => {
    render(<ShiftTypeGrid />);

    const cta = screen.getByTestId("shift-types-continue");
    // A real `<a href>`, so copy-link and open-in-new-tab keep working and the
    // shell's draft guard stages on a plain click. A <button> here would be a
    // second navigation lifecycle.
    expect(cta.tagName).toBe("A");
    expect(cta).toHaveAttribute("href", "/rules");
    expect(cta).toHaveTextContent("Continue to rules");
    // The prototype's 44px primary action, from the shared recipe rather than a
    // hand-rolled skin — same contract as the Dates and Staff CTAs. Compared as
    // the exact composed string, not token-by-token: the recipe's own
    // `font-medium` is legitimately REPLACED by the `font-bold` the siblings also
    // pass, so a presence check would either fail on it or have to special-case
    // it. Equality also means no extra visual class can be smuggled alongside.
    expect(cta.className).toBe(cn(buttonVariants({ size: "lg" }), "font-bold"));
  });

  it("leaves the Save button's visuals entirely to the Button recipe", async () => {
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
  it("runs the page heading at the display step with the negative-tracking rule", async () => {
    render(<ShiftTypeGrid />);
    const heading = screen.getByRole("heading", { level: 1 });
    const classes = heading.className.split(/\s+/);

    expect(classes).toContain("text-display");
    expect(classes).toContain("font-bold");
    expect(classes).toContain("tracking-[-0.015em]");
    // v1's `tracking-tight` is -0.025em, and the rule is unconditional at -0.015em.
    expect(classes).not.toContain("tracking-tight");
  });

  it("tracks every uppercase label at +0.03em and never at a bespoke value", async () => {
    await seed({ shifts: [{ id: "Day" }] });
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

  it("pairs the preferred-collapse warning's tint with its matching ink and border", async () => {
    await seedRequirements([baseline({ preferredNumPeople: 3 })], {
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

  it("pairs the save-failure notice's tint with its matching ink and border", async () => {
    await seedRequirements([baseline()], {
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
    // T03: Save awaits a queued repository command, so the on-card refusal notice
    // lands once the command settles.
    await act(async () => {
      await drainScenarioCommands();
    });

    const alert = screen.getByTestId(`shift-edit-${DAY}-save-error`);
    const classes = alert.className.split(/\s+/);
    expect(classes).toContain("bg-errortint");
    expect(classes).toContain("border-error");
    expect(classes).toContain("text-errorink");
    expect(classes).toContain("rounded-control");
    expect(alert).toHaveAttribute("role", "alert");
  });

  it("never leaves functional copy on --faint, and never authors a v1 escape", async () => {
    await seed({
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

describe("R2c accessibility — the bounded quick wins, per the ratified priority", () => {
  it("exposes the card grid as a NAMED region", async () => {
    await seed({ shifts: [{ id: "Day" }] });
    render(<ShiftTypeGrid />);

    // An unnamed <section> is not a region at all, so the grid was unreachable by
    // landmark navigation and indistinguishable from the Shift groups card.
    expect(screen.getByRole("region", { name: "Shift types" })).toBe(
      screen.getByTestId("shift-grid"),
    );
  });

  it("names the per-card actions by the shift they act on, keeping the visible label", async () => {
    await seed({ shifts: [{ id: "Day" }, { id: "Night" }] });
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

// Recipe OWNERSHIP of the inset-hairline surfaces is no longer proven by an AST
// oracle here or anywhere. `inset-hairline-ownership.test.ts` -- which resolved
// each governed node's className per NODE, because a file-wide predicate cannot
// tell "every governed tile calls the tuple" from "one tile was raw-reimplemented
// and a sibling still calls it" -- was deleted by custom-AST ticket 5, after the
// distinction it existed to draw was made unrepresentable rather than detected.
//
// Ownership now has three owners, none of them a source analyzer:
//
//   • `components/ui/inset-hairline-box.tsx` — every governed node is one of two
//     components whose `className` and `style` props are `never`, so there is no
//     per-node className to resolve and no sibling that can diverge from another;
//   • `components/ui/inset-hairline-box.test.tsx` — the emitted class list is
//     CLOSED over the recipe's own output, plus exact inline style and the
//     cast-away-caller refusal;
//   • `inset-hairline-box-authority` (ast-grep) — the owner file may author only
//     `<Surface>`, by any spelling, and bind only an allowlisted React surface.
//     This is the half no rendered check can own, because a hand-authored raw
//     element paints byte-identically to the recipe.
//
// The census above is what replaced the deleted analyzer's premise guard: it
// proves the components are MOUNTED at every governed site, in the state that
// renders each one.
