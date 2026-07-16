"use client";

// Top bar (T08). App title, mode toggle, undo/redo, theme/density/accent
// controls, and the New-schedule button. On mobile (below the 920px nav
// breakpoint) the sidebar is hidden and a hamburger drawer trigger replaces it.

import { ThemeToggle, DensityControl, AccentControl } from "@/components/theme/theme-toggle";
import { ModeToggle } from "./mode-toggle";
import { UndoRedoControls } from "./undo-redo-controls";
import { NewScheduleButton } from "./new-schedule-button";
import { MobileNav } from "./mobile-nav";
import { AppVersion } from "@/components/app-version";

export function TopBar() {
  return (
    <header
      data-testid="top-bar"
      className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-chrome px-3 text-onbrand sm:gap-3 sm:px-4"
    >
      {/* Mobile hamburger — visible on mobile, hidden on desktop (≥920px nav breakpoint) */}
      <span className="shrink-0 nav:hidden">
        <MobileNav />
      </span>

      {/* Title yields space first on narrow viewports so the action controls stay
          fully on-screen (no horizontal overflow at 320px). */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate font-heading text-cardhead font-bold tracking-tight">
          Nurse Scheduler
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <UndoRedoControls />
        <span className="hidden items-center gap-2 sm:flex">
          <ModeToggle />
        </span>
        <span className="hidden items-center gap-2 lg:flex">
          <DensityControl />
          <AccentControl />
        </span>
        <ThemeToggle />
        <NewScheduleButton />
        <span className="hidden sm:inline">
          <AppVersion />
        </span>
      </div>
    </header>
  );
}
