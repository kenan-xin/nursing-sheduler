// @vitest-environment jsdom

// The desktop compact rail's CONTENT contract (G8).
//
// The rail's measured geometry — 280↔60, the main column's width gain, the
// persistence-across-reload path, and the below-920 drawer independence — needs
// a real layout engine and lives in e2e/app-shell.spec.ts. What is provable here
// is the part a screenshot cannot check: that collapsing never removes a
// destination, never removes an accessible name, never removes the active
// signal, and never opens a second unguarded way to change mode.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { NavList } from "./sidebar-nav";
import { ModeToggle } from "./mode-toggle";
import { useModeStore } from "@/lib/mode/mode";
import { useNavGuardStore } from "./nav-guard-store";
import { getNavGroupsForMode } from "./nav-config";

vi.mock("next/navigation", () => ({
  usePathname: () => "/dates",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
// No shipped route is Advanced-only today, so the STAGING path is unreachable
// through real product code. The route-registry seam stands in for T08d's
// eventual invalid-route case, exactly as mode-toggle.test.tsx uses it — which
// is what lets the compact pill be tested against the guarded transaction
// rather than against the immediate-commit shortcut.
vi.mock("./route-registry", () => ({
  isRouteValidForMode: () => false,
  guidedFallbackPath: () => "/",
}));

const ACTIVE = "/dates";

beforeEach(() => {
  useModeStore.setState({ mode: "guided", adoption: "ready" });
  useNavGuardStore.setState({ drafts: new Map(), pendingIntent: null, open: false });
});
afterEach(() => cleanup());

describe("compact NavList — nothing is dropped, only the words are", () => {
  it("renders exactly the same destinations collapsed as expanded", () => {
    const expanded = render(<NavList activePath={ACTIVE} onNavigate={() => {}} />);
    const expandedPaths = getNavGroupsForMode("guided").flatMap((g) => g.items.map((i) => i.path));
    for (const path of expandedPaths) {
      expect(screen.getByTestId(`nav-link-${path}`)).toBeInTheDocument();
    }
    expanded.unmount();

    render(<NavList activePath={ACTIVE} onNavigate={() => {}} collapsed />);
    for (const path of expandedPaths) {
      expect(screen.getByTestId(`nav-link-${path}`)).toBeInTheDocument();
    }
    // A rail that quietly hid a destination would be the one failure mode a
    // screenshot at 60px could never reveal.
    expect(screen.getAllByTestId(/^nav-link-/)).toHaveLength(expandedPaths.length);
  });

  it("gives every icon-only row an accessible name AND a visible tooltip", () => {
    render(<NavList activePath={ACTIVE} onNavigate={() => {}} collapsed />);
    for (const group of getNavGroupsForMode("guided")) {
      for (const item of group.items) {
        const link = screen.getByTestId(`nav-link-${item.path}`);
        const name = link.getAttribute("aria-label");
        expect(name).toBeTruthy();
        expect(name).toContain(item.label);
        // The tooltip and the accessible name are the SAME string: a sighted
        // pointer user and a screen-reader user get the same fact.
        expect(link.getAttribute("title")).toBe(name);
        // Guided appends the workflow step, exactly like the prototype's tip.
        if (item.guidedStep != null) {
          expect(name).toBe(`${item.label} · step ${item.guidedStep}`);
        } else {
          expect(name).toBe(item.label);
        }
      }
    }
  });

  it("never invents a step ordinal in Advanced, which has no workflow to number", () => {
    useModeStore.setState({ mode: "advanced", adoption: "ready" });
    render(<NavList activePath="/rules" onNavigate={() => {}} collapsed />);
    for (const group of getNavGroupsForMode("advanced")) {
      for (const item of group.items) {
        const link = screen.getByTestId(`nav-link-${item.path}`);
        expect(link.getAttribute("aria-label")).toBe(item.label);
        expect(link.getAttribute("title")).not.toContain("step");
      }
    }
  });

  it("keeps the active row announced and visibly distinct", () => {
    render(<NavList activePath={ACTIVE} onNavigate={() => {}} collapsed />);
    const active = screen.getByTestId(`nav-link-${ACTIVE}`);
    expect(active).toHaveAttribute("aria-current", "page");
    expect(active.className).toContain("bg-brandtint");
    expect(active.className).toContain("text-brandink");

    const other = screen.getByTestId("nav-link-/");
    expect(other).not.toHaveAttribute("aria-current");
    expect(other.className).not.toContain("bg-brandtint");
  });

  it("keeps group structure as a NAMED separator rather than flattening it away", () => {
    render(<NavList activePath={ACTIVE} onNavigate={() => {}} collapsed />);
    for (const group of getNavGroupsForMode("guided")) {
      if (!group.label) continue;
      const rule = screen.getByTestId(`nav-group-label-${group.id}`);
      expect(rule).toHaveAttribute("role", "separator");
      // The heading survives as the separator's name and tooltip; only its
      // rendered WORDS are dropped, because 60px cannot hold them.
      expect(rule).toHaveAttribute("aria-label", group.label);
      expect(rule).toHaveAttribute("title", group.label);
      expect(rule.textContent).toBe("");
    }
  });

  it("keeps leading-[normal] on the merged row recipe, in BOTH states", () => {
    // tailwind-merge treats `font-size` as conflicting with `leading` (Tailwind's
    // `text-sm/6` sets both), so a `leading-*` placed EARLIER in the merged
    // string than `text-body` is silently dropped and the row inherits the 1.5
    // body line-height instead. That is a 38px → 41px regression with no type
    // error and no visual smoking gun, so it is pinned here as well as measured
    // in e2e/app-shell-rebuild.spec.ts.
    const expanded = render(<NavList activePath={ACTIVE} onNavigate={() => {}} />);
    expect(screen.getByTestId(`nav-link-${ACTIVE}`).className).toContain("leading-[normal]");
    expanded.unmount();

    render(<NavList activePath={ACTIVE} onNavigate={() => {}} collapsed />);
    expect(screen.getByTestId(`nav-link-${ACTIVE}`).className).toContain("leading-[normal]");
  });

  it("still navigates from a collapsed row", () => {
    const onNavigate = vi.fn();
    render(<NavList activePath={ACTIVE} onNavigate={onNavigate} collapsed />);
    screen.getByTestId("nav-link-/people").click();
    expect(onNavigate).toHaveBeenCalledWith("/people");
  });
});

describe("compact ModeToggle — one pill, same transaction", () => {
  it("abbreviates the current mode and names the move it makes", () => {
    render(<ModeToggle compact />);
    const control = screen.getByTestId("mode-toggle");
    expect(control.textContent).toBe("GUI");
    expect(control).toHaveAttribute("aria-label", "Guided mode — switch to Advanced");
    // The abbreviation alone would not say which direction it moves, so the
    // title states both the current mode and the action.
    expect(control.getAttribute("title")).toBe(control.getAttribute("aria-label"));
  });

  it("toggles to Advanced and re-labels itself", () => {
    render(<ModeToggle compact />);
    act(() => screen.getByTestId("mode-toggle").click());
    expect(useModeStore.getState().mode).toBe("advanced");
    const control = screen.getByTestId("mode-toggle");
    expect(control.textContent).toBe("ADV");
    expect(control).toHaveAttribute("aria-label", "Advanced mode — switch to Guided");
  });

  it("routes through the guarded mode transaction, not a bare setMode", () => {
    // An open draft stages the change instead of committing it. If the compact
    // pill wrote the store directly it would be a second, unguarded way to
    // change mode and would lose the draft without asking.
    useNavGuardStore.getState().registerDraft({ id: "d", label: "Draft" });
    render(<ModeToggle compact />);
    act(() => screen.getByTestId("mode-toggle").click());
    expect(useNavGuardStore.getState().pendingIntent).not.toBeNull();
    expect(useModeStore.getState().mode).toBe("guided");
  });

  it("still renders the two-segment tablist when not compact", () => {
    render(<ModeToggle />);
    expect(screen.getByTestId("mode-toggle")).toHaveAttribute("role", "tablist");
    expect(screen.getByTestId("mode-toggle-guided")).toBeInTheDocument();
    expect(screen.getByTestId("mode-toggle-advanced")).toBeInTheDocument();
  });
});
