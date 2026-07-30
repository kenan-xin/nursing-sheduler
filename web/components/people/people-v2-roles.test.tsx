// @vitest-environment jsdom
import "fake-indexeddb/auto";
//
// R2b — the People route's v2 visual-role contract, asserted at the component
// boundary.
//
// What this file is FOR, and what it deliberately is not. F4's browser matrix
// proves the RESOLVED paint for `/people` (tone, elevation, radius, contrast,
// coarse targets) in a real Chromium. It cannot prove which CONTRACT produced
// that paint: a hand-authored `bg-panel` header row and the shared `band` role
// compute identically, and the whole point of the re-skin is that this screen
// stops forking its own presentation. So these tests pin the AUTHORITY — the
// surface recipe's roles and the shared primitives' slots — and are
// discriminating precisely where a regression would be invisible downstream:
// swapping a role back to a literal utility, restoring the `.ns-btn` CTA, or
// re-authoring the drag indicator as an arbitrary `shadow-[…]`.
//
// The resolved half — computed tone, 16px/0px radii, the clipped scroll region,
// real target geometry and narrow-viewport behaviour — lives in
// `e2e/people.spec.ts`, which measures a real browser.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ScenarioUiState } from "@/lib/scenario";
import {
  drainScenarioPersist,
  resetToNewScenario,
  useHotStore,
  useScenarioStore,
} from "@/lib/store";
import { surfaceVariants } from "@/components/ui/surface";
import { PeopleTable } from "./people-table";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/people",
}));

const sk = (id: string) => `string:${id}`;

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

// The v1 presentation this ticket retired. `.ns-btn` / `.ns-btn--primary` were the
// LAST live consumers of the retired button fork anywhere in the app; the rules
// themselves were deleted from `components/dates/calendar.css` with this change,
// so any of these reappearing means the screen drifted back off the shared
// contract onto a stylesheet that no longer exists.
const RETIRED_V1_CLASSES = [
  "ns-btn",
  "ns-input",
  "ns-switch",
  "ns-icon-btn",
  "ns-square-btn",
  "ns-quick-pick",
  "ns-day-chip",
  "ns-derived-chip",
];

function seed(patch: Partial<ScenarioUiState>) {
  act(() => {
    useScenarioStore.getState().mutateScenario(patch);
  });
}

function seedWard() {
  seed({
    staff: [
      { id: "Aisha Rahman", history: [] },
      { id: "Priya Nair", history: [] },
      { id: "Kevin Ong", history: [] },
    ],
    staffGroups: [{ id: "Seniors", members: ["Aisha Rahman"] }],
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetToNewScenario(useScenarioStore, useHotStore);
  await drainScenarioPersist(useScenarioStore);
});
afterEach(() => cleanup());

describe("R2b — People surface roles", () => {
  it("seats the screen on the L0 page plane through the shared adapter", () => {
    seedWard();
    render(<PeopleTable />);

    const root = screen.getByTestId("screen");
    // The adapter, not a literal `bg-bg`: F4's manifest declares this exact
    // element as the route's `page` role and reads its RESOLVED tone.
    expect(root.getAttribute("data-slot")).toBe("surface");
    expect(root.getAttribute("data-level")).toBe("page");
    expect(root.getAttribute("data-geometry")).toBe("square");
    expectRole(root, { role: "page", geometry: "square" });
    // L0 is flat by contract — nothing floats free on the page plane.
    expect(root.className).not.toContain("shadow-1");
  });

  it("makes the table container a resting L1 card that clips its own scroll region", () => {
    seedWard();
    render(<PeopleTable />);

    const wrap = screen.getByTestId("people-table-wrap");
    expectRole(wrap, { role: "surface", geometry: "card" });
    // DESIGN.md §4 rule 3: the scroll region ends the card, so it takes the card
    // radius AND clips to it — otherwise rows hit a square edge inside a rounded
    // container and the list reads truncated rather than scrollable.
    expect(wrap.className).toContain("rounded-card");
    expect(wrap.className).toContain("overflow-x-auto");
  });

  it("renders the column header as a full-bleed square band, never a well", () => {
    seedWard();
    render(<PeopleTable />);

    const band = screen.getByRole("columnheader", { name: "Nurse" }).parentElement!;
    expectRole(band, { role: "band", geometry: "square" });
    expect(band.className).toContain("rounded-none");
    // A band that spans the whole card is flat: no inset cast, no outer shadow.
    expect(band.className).not.toContain("shadow-well");
    expect(band.className).not.toContain("shadow-1");
  });

  it("keeps every data surface explicitly square", () => {
    seedWard();
    render(<PeopleTable />);

    const table = screen.getByTestId("people-table");
    const surfaces = [table, ...Array.from(table.querySelectorAll("thead, tbody, tr, th, td"))];
    expect(surfaces.length).toBeGreaterThan(10);
    for (const el of surfaces) {
      const rounded = el.className
        .split(/\s+/)
        .filter((c) => c.startsWith("rounded-") && c !== "rounded-none");
      expect(rounded, `${el.tagName.toLowerCase()} must not round`).toEqual([]);
    }
  });
});

describe("R2b — row states", () => {
  it("hovers rows to --panel-alt, not the band tone", () => {
    seedWard();
    render(<PeopleTable />);

    const row = screen.getByTestId(`people-row-${sk("Aisha Rahman")}`);
    const tokens = row.className.split(/\s+/);
    expect(tokens).toContain("hover:bg-panel-alt");
    // DESIGN.md §6: `--panel` is reserved for header bands and true insets. The
    // prototype hovers rows to `--panel`, which would collide with the header
    // band directly above them. Compared as a whole token, so `hover:bg-panel-alt`
    // cannot satisfy the check by prefix.
    expect(tokens).not.toContain("hover:bg-panel");
  });

  it("marks the drop candidate with the shared drop-target LANGUAGE, not an arbitrary shadow", () => {
    seedWard();
    render(<PeopleTable />);

    const source = screen.getByTestId(`people-row-${sk("Aisha Rahman")}`);
    const target = screen.getByTestId(`people-row-${sk("Priya Nair")}`);

    fireEvent.dragStart(source);
    fireEvent.dragOver(target);

    // Dashed brand edge over the hover tone — the same reading the `drop-target`
    // recipe role publishes. NOT `--brandtint` + a solid brand border, which v2
    // reserves for selection.
    expect(target.className).toContain("border-dashed");
    expect(target.className).toContain("border-brand");
    expect(target.className).toContain("bg-panel-alt");
    expect(target.className).not.toContain("bg-brandtint");
    // The v1 indicator was `shadow-[inset_0_2px_0_var(--color-brand)]`, an
    // arbitrary elevation the static provenance gate rejects outright.
    expect(target.className).not.toContain("shadow-[");
    // The source row dims while it moves.
    expect(source.className).toContain("opacity-50");
  });

  it("promotes the open inline editor row to the shared selected role", () => {
    seedWard();
    render(<PeopleTable />);

    fireEvent.click(screen.getByTestId(`people-edit-${sk("Aisha Rahman")}`));
    const row = screen.getByTestId(`people-edit-row-${sk("Aisha Rahman")}`);

    expectRole(row, { role: "selected", geometry: "square" });
    expect(row.className).toContain("border-brand");
    // The prototype washes the editing row in `--brandtint`; DESIGN.md §6 reserves
    // that tone for the selection MARKS, and the brand-filled group toggles inside
    // this very row would vanish into it.
    expect(row.className).not.toContain("bg-brandtint");
  });
});

describe("R2b — primitive adoption", () => {
  it("wears the shared Button recipe on the Continue CTA, not the retired .ns-btn fork", () => {
    seedWard();
    render(<PeopleTable />);

    const cta = screen.getByTestId("people-continue");
    // Still a real anchor, so copy-link and open-in-new-tab keep working and the
    // shell's draft guard still stages on a plain click.
    expect(cta.tagName).toBe("A");
    expect(cta).toHaveAttribute("href", "/shift-types");
    expect(cta.className).toContain("rounded-pill");
    expect(cta.className).toContain("bg-brand");
    expect(cta.className).toContain("text-onbrand");
    expect(cta.className).toContain("shadow-1");
    // The prototype's 44px primary action, and a real coarse floor on both axes.
    expect(cta.className).toContain("h-control-lg");
    expect(cta.className).toContain("pointer-coarse:min-h-touch");
    expect(cta.className).toContain("pointer-coarse:min-w-touch");
  });

  /** Pill + a real 44x44 floor on BOTH axes, set on the control itself. */
  function expectSharedButton(testId: string) {
    const button = screen.getByTestId(testId);
    expect(button.getAttribute("data-slot"), testId).toBe("button");
    expect(button.className, testId).toContain("rounded-pill");
    expect(button.className, testId).toContain("pointer-coarse:min-h-touch");
    expect(button.className, testId).toContain("pointer-coarse:min-w-touch");
  }

  it("makes every resting-row action a shared Button with a real coarse floor", () => {
    seedWard();
    render(<PeopleTable />);

    for (const testId of [
      "people-add",
      "people-upload",
      `people-move-up-${sk("Kevin Ong")}`,
      `people-move-down-${sk("Aisha Rahman")}`,
      `people-edit-${sk("Aisha Rahman")}`,
      `people-dup-${sk("Aisha Rahman")}`,
      `people-delete-${sk("Aisha Rahman")}`,
    ]) {
      expectSharedButton(testId);
    }
  });

  it("makes every inline-editor action a shared Button with a real coarse floor", () => {
    seedWard();
    render(<PeopleTable />);

    // Opening a row closes the reorder affordances (drag and keyboard alike), so
    // the editing controls are asserted in their own render rather than beside
    // controls the editor deliberately removes.
    fireEvent.click(screen.getByTestId(`people-edit-${sk("Priya Nair")}`));
    expect(screen.queryByTestId(`people-move-up-${sk("Kevin Ong")}`)).toBeNull();

    for (const testId of [
      `people-save-${sk("Priya Nair")}`,
      `people-cancel-${sk("Priya Nair")}`,
      `people-group-${sk("Priya Nair")}-Seniors`,
    ]) {
      expectSharedButton(testId);
    }
  });

  it("marks the row delete as a destructive OUTLINE, never a solid fill", () => {
    seedWard();
    render(<PeopleTable />);

    const del = screen.getByTestId(`people-delete-${sk("Aisha Rahman")}`);
    expect(del.className).toContain("border-error");
    expect(del.className).toContain("text-errorink");
    expect(del.className).toContain("hover:bg-errortint");
    expect(del.className).not.toContain("bg-fill-error");
  });

  it("toggles a group membership chip between the brand fill and L1, with aria-pressed", () => {
    seedWard();
    render(<PeopleTable />);

    fireEvent.click(screen.getByTestId(`people-edit-${sk("Priya Nair")}`));
    const chip = () => screen.getByTestId(`people-group-${sk("Priya Nair")}-Seniors`);

    expect(chip().getAttribute("aria-pressed")).toBe("false");
    expect(chip().className).toContain("bg-surface");

    fireEvent.click(chip());

    expect(chip().getAttribute("aria-pressed")).toBe("true");
    expect(chip().className).toContain("bg-brand");
    // Text on a solid semantic fill takes the paired ON-colour, never a
    // hand-picked foreground (DESIGN.md §6).
    expect(chip().className).toContain("text-onbrand");
  });

  it("renders group chips on a read row as authored-case badges", () => {
    seedWard();
    render(<PeopleTable />);

    const row = screen.getByTestId(`people-row-${sk("Aisha Rahman")}`);
    const badges = within(row).getAllByText("Seniors");
    expect(badges.length).toBe(1);
    expect(badges[0].getAttribute("data-slot")).toBe("badge");
    expect(badges[0].className).toContain("rounded-chip");
    // A person's group name is authored data and reads exactly as typed; only
    // status eyebrows uppercase.
    expect(badges[0].className).toContain("normal-case");
  });

  it("gives the search clear a real 44px coarse box rather than a bare glyph", () => {
    seedWard();
    render(<PeopleTable />);

    fireEvent.change(screen.getByTestId("people-search"), { target: { value: "ai" } });
    const clear = screen.getByTestId("people-search-clear");
    expect(clear.tagName).toBe("BUTTON");
    // The control itself grows — not an overlapping pseudo-element hitbox (T8).
    expect(clear.className).toContain("pointer-coarse:size-touch");
  });

  it("makes the empty state's Clear search a real control on the link variant", () => {
    seed({ staff: [{ id: "Aisha Rahman", history: [] }], staffGroups: [] });
    render(<PeopleTable />);

    fireEvent.change(screen.getByTestId("people-search"), { target: { value: "zzz" } });
    const clear = screen.getByTestId("people-empty-clear");
    expect(clear.getAttribute("data-slot")).toBe("button");
    expect(clear.className).toContain("text-brandink");
    expect(clear.className).toContain("pointer-coarse:min-h-touch");
  });
});

describe("R2b — no v1 residue", () => {
  it("authors no retired v1 control class, editor and search state open", () => {
    seedWard();
    const { container } = render(<PeopleTable />);

    fireEvent.click(screen.getByTestId(`people-edit-${sk("Aisha Rahman")}`));
    for (const cls of RETIRED_V1_CLASSES) {
      expect(container.querySelectorAll(`[class*="${cls}"]`), cls).toHaveLength(0);
    }
  });

  it("reserves --faint for the genuinely non-functional empty-cell mark", () => {
    seed({ staff: [{ id: "Aisha Rahman", history: [] }], staffGroups: [] });
    render(<PeopleTable />);

    // The em-dash standing in for "no groups" IS an empty-cell mark, which is
    // exactly what DESIGN.md §2 keeps `--faint` for.
    const row = screen.getByTestId(`people-row-${sk("Aisha Rahman")}`);
    expect(within(row).getByText("—").className).toContain("text-faint");

    // Real copy is NOT. v1 rendered the "no groups yet" sentence in `--faint`,
    // which is the sub-AA tertiary exemption v2 retires (DESIGN.md §2).
    fireEvent.click(screen.getByTestId(`people-edit-${sk("Aisha Rahman")}`));
    const note = screen.getByText(/No groups yet/);
    expect(note.className).toContain("text-ink3");
    expect(note.className).not.toContain("text-faint");
  });
});
