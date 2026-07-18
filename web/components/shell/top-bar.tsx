"use client";

// Contextual top bar (T08, BLOCKER 1 / MAJOR 5). This is NOT a full-viewport
// chrome bar: it is the 56px `bg-surface` header that lives INSIDE the right-hand
// main column, beside the branded rail (see app-shell.tsx). Its job is
// orientation, not controls: the mobile menu, a small product tile, the current
// route crumb, the scenario context, the persistence status, and the (secondary)
// global undo/redo. Mode, density, accent, theme, New-schedule and version have
// moved to their owning surfaces (SideNav / display settings / Save & Load).

import { usePathname } from "next/navigation";
import { useScenarioStore } from "@/lib/store";
import { useAppMode } from "@/lib/mode/use-mode";
import { getNavItemForMode } from "./nav-config";
import { UndoRedoControls } from "./undo-redo-controls";
import { PersistenceStatus } from "./persistence-status";
import { MobileNav } from "./mobile-nav";
import { FaDiagramProject } from "@/components/icons";

// T08d repair (P2): resolves through `getNavItemForMode` — the same
// `getNavGroupsForMode` projection the sidebar/Home/mobile drawer render —
// rather than an unfiltered lookup, so the crumb can never drift from what
// the current mode actually exposes. An Advanced-only route is only ever
// mounted while mode is Advanced (route-validity gate redirects otherwise),
// so this always resolves for a genuinely reachable page.
function useCrumb(): string {
  const pathname = usePathname();
  const mode = useAppMode();
  if (pathname === "/") return "Home";
  return getNavItemForMode(pathname, mode)?.label ?? "Home";
}

export function TopBar() {
  const crumb = useCrumb();
  const scenarioName = useScenarioStore((s) => s.meta.description);

  return (
    <header
      data-testid="top-bar"
      className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-4 sm:px-5"
    >
      {/* Mobile hamburger — visible below the 920px nav breakpoint only. */}
      <span className="shrink-0 nav:hidden">
        <MobileNav />
      </span>

      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex size-[26px] shrink-0 items-center justify-center bg-chrome text-[13px] text-on-ink">
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
