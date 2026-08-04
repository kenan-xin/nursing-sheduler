// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HomeScreen } from "./home-screen";
import { useModeStore } from "@/lib/mode/mode";
import { useNavGuardStore } from "@/components/shell/nav-guard-store";
import { useHotStore, useScenarioStore, resetToNewScenario } from "@/lib/store";

// R1 — the v2 re-skin of Home. These are the facts the re-skin can silently
// break and that no other suite holds:
//
//   • the F4 row's own semantic claim (the Home root IS the L0 page plane) is
//     asserted in a browser by the visual matrix, but the class that makes it
//     true is authored here, and a transparent root reads as "no violation" to
//     an analytic scanner rather than as a failure;
//   • the stat strip's column ladder, which the ticket pins as 2→3→5 with no
//     stranded fifth card. A wrong ladder still renders five stats;
//   • the two-mode branch and the guarded-navigation routing, which the visual
//     matrix never exercises;
//   • the v1 presentation this ticket removes — residue is invisible unless a
//     test names it.
//
// `scenario-summary.test.ts` remains the behavior regression gate for the
// readiness model itself; nothing here re-derives it.

const push = vi.fn();
const replace = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push, replace }),
}));

function classesOf(element: Element | null): string {
  return element?.getAttribute("class") ?? "";
}

/** The rendered Home root. */
function root(): HTMLElement {
  return screen.getByTestId("home-screen");
}

beforeEach(async () => {
  vi.clearAllMocks();
  useModeStore.setState({ mode: "guided" });
  useNavGuardStore.setState({ drafts: new Map(), pendingIntent: null, open: false });
  await resetToNewScenario(useScenarioStore, useHotStore);
});

afterEach(() => cleanup());

describe("HomeScreen — two-mode composition", () => {
  it("renders the guided body, and the header and stat strip in BOTH modes", () => {
    render(<HomeScreen />);
    expect(root().getAttribute("data-mode")).toBe("guided");
    expect(screen.getByTestId("home-wizard-grid")).toBeTruthy();
    expect(screen.getByTestId("home-progress")).toBeTruthy();
    expect(screen.getByTestId("home-stat-strip")).toBeTruthy();
    expect(screen.getByTestId("home-generate")).toBeTruthy();
    expect(screen.queryByTestId("home-advanced")).toBeNull();
  });

  it("swaps only the body when the mode lens flips to advanced", () => {
    render(<HomeScreen />);
    act(() => {
      useModeStore.setState({ mode: "advanced" });
    });

    expect(root().getAttribute("data-mode")).toBe("advanced");
    expect(screen.getByTestId("home-advanced")).toBeTruthy();
    expect(screen.queryByTestId("home-wizard-grid")).toBeNull();
    // The header and strip are mode-independent — a body swap must not take them.
    expect(screen.getByTestId("home-stat-strip")).toBeTruthy();
    expect(screen.getByTestId("home-generate")).toBeTruthy();
  });
});

describe("HomeScreen — v2 surface and geometry contract", () => {
  it("paints the Home root as the L0 page plane", () => {
    render(<HomeScreen />);
    // F4's R1 row declares this element `role: page`, which resolves to --bg with
    // no elevation. An unpainted root inherits its ancestor and computes
    // `rgba(0, 0, 0, 0)`, which the runtime scanner cannot judge as the page
    // tone — so the class has to be here, explicitly.
    expect(classesOf(root())).toContain("bg-bg");
    expect(classesOf(root())).not.toMatch(/\bshadow-[123]\b/);
  });

  it("gives the stat strip the deterministic 2→3→5 ladder with no stranded fifth card", () => {
    render(<HomeScreen />);
    const classes = classesOf(screen.getByTestId("home-stat-strip"));
    expect(classes).toContain("grid-cols-2");
    expect(classes).toContain("min-[560px]:grid-cols-3");
    expect(classes).toContain("grid2:grid-cols-5");
    // The regression: a 2→5 ladder at `sm` (640px) leaves the fifth stat alone
    // on a full-width row for the whole 640–899px band.
    expect(classes).not.toContain("sm:grid-cols-5");
  });

  it("rounds the stat strip as one L1 card and clips its square cells into it", () => {
    render(<HomeScreen />);
    const classes = classesOf(screen.getByTestId("home-stat-strip"));
    expect(classes).toContain("rounded-card");
    expect(classes).toContain("shadow-1");
    // Without the clip, the 1px divider gaps square off the rounded corners.
    expect(classes).toContain("overflow-hidden");
  });
});

describe("HomeScreen — typography and copy", () => {
  it("keeps the product eyebrow copy and drops the v1 leader-dot ornament", () => {
    render(<HomeScreen />);
    // DESIGN.md §5 retires decorative ornament on labels; the deviation matrix
    // keeps product copy above the prototype's own example wording.
    expect(screen.getByText("Ward Scheduling")).toBeTruthy();
    expect(root().textContent).not.toContain("●");
  });

  it("tracks R1-owned headings at the v2 -0.015em, not a Tailwind default", () => {
    render(<HomeScreen />);
    const heading = screen.getByRole("heading", { level: 1 });
    // The heading states the v2 value itself as a component contract; the global
    // h1–h6 rule is the same -0.015em, while `tracking-tight` is -0.025em.
    expect(classesOf(heading)).toContain("tracking-[-0.015em]");
    expect(classesOf(heading)).not.toContain("tracking-tight");
    expect(classesOf(heading)).not.toContain("font-extrabold");
  });
});

describe("HomeScreen — guided wizard cards", () => {
  /** Make step 1 (Dates) genuinely done, so Done/Current/To do all render. */
  function completeDates() {
    act(() => {
      useScenarioStore
        .getState()
        .mutateScenario({ rangeStart: "2026-02-01", rangeEnd: "2026-02-28" });
    });
  }

  it("carries status on the shared Badge recipe, so every tint has its semantic ink AND border", () => {
    completeDates();
    render(<HomeScreen />);

    const done = screen.getByTestId("home-badge-/dates");
    const current = screen.getByTestId("home-badge-/people");
    const todo = screen.getByTestId("home-badge-/rules");

    // DESIGN.md's Redundant Signal Rule: state never rests on colour contrast
    // alone, so the border is part of the contract, not decoration. A
    // hand-rolled tint/ink pair satisfies neither it nor the shared geometry.
    for (const badge of [done, current, todo]) {
      expect(badge.getAttribute("data-slot")).toBe("badge");
      expect(classesOf(badge)).toContain("rounded-chip");
      expect(classesOf(badge)).toMatch(/\bborder\b/);
    }
    expect(done.getAttribute("data-variant")).toBe("success");
    expect(current.getAttribute("data-variant")).toBe("brand");
    expect(todo.getAttribute("data-variant")).toBe("neutral");

    // Status reads as words, uppercased by the recipe — no check glyph, no dot.
    expect(done.textContent).toBe("Done");
    expect(classesOf(done)).toContain("uppercase");
    expect(screen.getByTestId("home-wizard-grid").textContent).not.toContain("✓");
  });

  it("gives only the current step the `selected` surface role", () => {
    completeDates();
    render(<HomeScreen />);

    const current = classesOf(screen.getByTestId("home-card-/people"));
    const resting = classesOf(screen.getByTestId("home-card-/rules"));

    // `selected` is --surface + a --brand border + --sh-2; resting L1 is the
    // --line hairline at --sh-1. Both come from the one surface authority.
    expect(current).toContain("border-brand");
    expect(current).toContain("shadow-2");
    expect(resting).toContain("border-line");
    expect(resting).toContain("shadow-1");
    expect(resting).not.toContain("border-brand");
  });

  it("builds the step CTAs from the shared Button recipe at the absolute control height", () => {
    completeDates();
    render(<HomeScreen />);

    const currentCta = classesOf(screen.getByTestId("home-cta-/people"));
    const restingCta = classesOf(screen.getByTestId("home-cta-/rules"));

    // `h-control` is the absolute 36px token. `h-9` would resolve through
    // --spacing (the 0.9 density baseline) to 32.4px.
    expect(currentCta).toContain("h-control");
    expect(currentCta).not.toContain("h-9");
    expect(currentCta).toContain("bg-brand");
    // Secondary/ghost are L1, never transparent (DESIGN.md §4 rule 4).
    expect(restingCta).toContain("bg-surface");
    expect(restingCta).not.toContain("bg-transparent");
    // The recipe's coarse-pointer floor rides along on every step CTA.
    expect(restingCta).toContain("pointer-coarse:min-h-touch");
  });

  it("labels each CTA from its own step status", () => {
    completeDates();
    render(<HomeScreen />);
    expect(screen.getByTestId("home-cta-/dates").textContent).toContain("Review");
    expect(screen.getByTestId("home-cta-/people").textContent).toContain("Continue");
    expect(screen.getByTestId("home-cta-/rules").textContent).toContain("Set up");
  });
});

describe("HomeScreen — guarded navigation from the header CTA", () => {
  it("routes the Generate CTA through the guard when nothing is dirty", () => {
    render(<HomeScreen />);
    fireEvent.click(screen.getByTestId("home-generate"));
    expect(push).toHaveBeenCalledWith("/optimize-and-export");
    expect(useNavGuardStore.getState().open).toBe(false);
  });

  it("stages the confirm instead of navigating while a losable draft is open", () => {
    render(<HomeScreen />);
    act(() => {
      useNavGuardStore.getState().registerDraft({ id: "d", label: "Draft" });
    });

    fireEvent.click(screen.getByTestId("home-generate"));

    // The CTA is not a bypass: an in-progress draft is protected even from Home.
    expect(push).not.toHaveBeenCalled();
    expect(useNavGuardStore.getState().pendingIntent).not.toBeNull();

    act(() => {
      useNavGuardStore.getState().confirm();
    });
    expect(push).toHaveBeenCalledWith("/optimize-and-export");
  });
});
