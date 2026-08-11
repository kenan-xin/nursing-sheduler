"use client";

// Contextual top bar (T08, BLOCKER 1 / MAJOR 5). This is NOT a full-viewport
// chrome bar: it is the `h-14` `bg-surface` header that lives INSIDE the right-hand
// main column, beside the branded rail (see app-shell.tsx). `h-14` resolves to
// 50px, not the prototype's 56: Tailwind's `--spacing` base carries the 0.9
// baseline (globals.css), and the shell scales with the content it frames — the
// e2e geometry check pins the scaled figure (nursing-sheduler-yea). Its job is
// orientation, not controls: the mobile menu, a small product tile, the current
// route crumb, the scenario context, the persistence status, and the (secondary)
// global undo/redo. Mode, accent, theme, New-schedule and version have
// moved to their owning surfaces (SideNav / display settings / Save & Load).

import { usePathname } from "next/navigation";
import { useScenarioStore } from "@/lib/store";
import { useAppMode } from "@/lib/mode/use-mode";
import { getNavGroupsForMode, getNavItemForMode } from "./nav-config";
import { UndoRedoControls } from "./undo-redo-controls";
import { PersistenceStatus } from "./persistence-status";
import { MobileNav } from "./mobile-nav";
import { Button } from "@/components/ui/button";
import { surfaceVariants } from "@/components/ui/surface";
import { cn } from "@/lib/utils";
import { FaAnglesLeft, FaAnglesRight, FaDiagramProject } from "@/components/icons";
import { useSideCollapsed, useSideCollapseActions } from "./use-side-collapse";

// T08d repair (P2): resolves through `getNavItemForMode` — the same
// `getNavGroupsForMode` projection the sidebar/Home/mobile drawer render —
// rather than an unfiltered lookup, so the crumb can never drift from what
// the current mode actually exposes. An Advanced-only route is only ever
// mounted while mode is Advanced (route-validity gate redirects otherwise),
// so this always resolves for a genuinely reachable page.
//
// CW-6: restores the prototype's "Step N ·" crumb prefix (Nurse Scheduling
// 1186) for the five SET UP steps only — the prototype's own crumbMap gives
// `generate` (Optimize & Export, guidedStep 6 but OUTPUT-group) a plain
// label with no ordinal, so the prefix is gated on Set-up group membership
// rather than on `guidedStep` alone.
function useCrumb(): string {
  const pathname = usePathname();
  const mode = useAppMode();
  if (pathname === "/") return "Home";
  const item = getNavItemForMode(pathname, mode);
  if (!item) return "Home";
  if (item.guidedStep == null) return item.label;
  const inSetupGroup = getNavGroupsForMode(mode).some(
    (group) => group.id === "setup" && group.items.some((i) => i.path === pathname),
  );
  return inSetupGroup ? `Step ${item.guidedStep} · ${item.label}` : item.label;
}

export function TopBar() {
  const crumb = useCrumb();
  const scenarioName = useScenarioStore((s) => s.meta.description);

  return (
    <header
      data-testid="top-bar"
      // Side padding is FLAT: the prototype header is `padding:0 var(--space-5)` with
      // no media query (Nurse Scheduling v2.dc.html:238). The `px-4 sm:px-5` this carried
      // pivoted at 640px, a step the design does not have — and it tightened the phone
      // case, where the rail is hidden and there is more room, not less.
      //
      // Tone, single bottom edge and elevation come from the `sticky` surface
      // role — an L1 plane that carries --sh-1 and stays square, because a
      // rounded corner on a full-bleed bar leaves a sliver of page background
      // in the corner (DESIGN.md §5).
      className={cn(
        "sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 px-5",
        surfaceVariants({ role: "sticky", geometry: "square" }),
      )}
    >
      {/* Desktop sidebar collapse — the far-left control, at and above the 920px
          nav breakpoint only (G8). Below that the rail does not exist and the
          drawer is always expanded, so a collapse control there would toggle a
          preference with nothing to show for it. */}
      <SideCollapseToggle />

      {/* Mobile hamburger — visible below the 920px nav breakpoint only. */}
      <span className="shrink-0 nav:hidden">
        <MobileNav />
      </span>

      <div className="flex min-w-0 items-center gap-2.5">
        {/* `--chrome` aliases the live `--brand`, so the tile's foreground is the
            accent's paired `--onbrand`, not the ink ramp's `--on-ink`. */}
        <span className="flex size-[26px] shrink-0 items-center justify-center rounded-chip bg-chrome text-[13px] text-onbrand">
          <FaDiagramProject />
        </span>
        <span
          data-testid="route-crumb"
          className="truncate text-label uppercase tracking-[0.03em] text-ink2"
        >
          {crumb}
        </span>
      </div>

      <div className="flex-1" />

      <div className="flex shrink-0 items-center gap-3">
        <span
          data-testid="scenario-context"
          className="hidden max-w-[36ch] truncate text-label uppercase tracking-[0.03em] text-ink3 sm:inline"
        >
          {scenarioName || "Untitled schedule"}
        </span>
        <PersistenceStatus />
        <UndoRedoControls />
      </div>
    </header>
  );
}

/**
 * The desktop rail's collapse/expand control (G8).
 *
 * Rendered through the shared `Button` (`ghost` / `icon`) rather than a one-off:
 * that is the system's 36px square control token, it already carries the
 * coarse-pointer 44px floor on the real control, and it is the same L1
 * surface + hairline + `--sh-1` treatment every other icon control in the shell
 * uses. `aria-expanded` + `aria-controls` point at the rail itself, so the
 * control announces what it operates on rather than just naming itself, and the
 * label states the ACTION (what pressing it will do) in both `title` and
 * `aria-label`.
 */
function SideCollapseToggle() {
  const collapsed = useSideCollapsed();
  const { toggleCollapsed } = useSideCollapseActions();
  const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
  const Icon = collapsed ? FaAnglesRight : FaAnglesLeft;

  return (
    <Button
      variant="ghost"
      size="icon"
      data-testid="side-collapse-toggle"
      onClick={toggleCollapsed}
      aria-label={label}
      aria-expanded={!collapsed}
      aria-controls="app-side-nav"
      title={label}
      className="hidden shrink-0 text-ink2 nav:inline-flex [&_svg]:size-3.5"
    >
      <Icon aria-hidden />
    </Button>
  );
}
