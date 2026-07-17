"use client";

// Shared side navigation (T08, MAJOR 3). The single four-part rail from the
// prototype (SideNav.dc.html): Rota brand header → labeled Mode control → the
// scrolling nav list → an identity/theme footer. It is rendered verbatim in BOTH
// the desktop rail (app-shell) and the mobile drawer (mobile-nav), so their
// hierarchy, brand, mode ownership and footer never diverge.
//
// Product decision (MAJOR 3): there is no account or ward backend in scope, so
// the prototype's hard-coded "Aisha Rahman / Head Nurse" identity is NOT revived.
// The footer instead shows the honest workspace identity — the data is persisted
// locally in this browser (T04) — and the top bar surfaces the real scenario name
// from `meta.description`.
//
// Footer (audit MAJOR 5): the persistent sidebar footer is exactly identity +
// one 34×34 theme control, matching SideNav.dc.html:48-55. The density/accent
// display settings were prototype preview-only props and are no longer chrome —
// they remain exposed on the /design-system page.
//
// `headerActions` reserves a trailing slot in the brand header for the mobile
// drawer's accessible close control (audit m8), without overlaying the brand
// lockup and without appearing on the desktop rail.

import { type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useGuardedNavigation } from "./use-guarded-navigation";
import { NavList } from "./sidebar-nav";
import { ModeToggle } from "./mode-toggle";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { FaDiagramProject } from "@/components/icons";

export function AppSideNav({
  onAfterNavigate,
  headerActions,
}: {
  onAfterNavigate?: () => void;
  headerActions?: ReactNode;
}) {
  const pathname = usePathname();
  const { navigate } = useGuardedNavigation();

  const go = (path: string) => {
    navigate(path);
    onAfterNavigate?.();
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Brand */}
      <div className="flex items-center gap-2.5 border-b border-line2 px-4 pb-3.5 pt-4.5">
        <span className="flex size-[30px] shrink-0 items-center justify-center bg-chrome text-[14px] text-on-ink">
          <FaDiagramProject />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-heading text-title font-extrabold leading-none tracking-tight">
            Rota
          </div>
          <div className="mt-[3px] text-label font-semibold uppercase leading-[normal] tracking-[0.03em] text-ink3">
            Nurse Scheduling
          </div>
        </div>
        {headerActions ? <div className="flex shrink-0 items-center">{headerActions}</div> : null}
      </div>

      {/* Mode */}
      <div className="flex flex-col gap-1.5 px-4 pb-2.5 pt-3.5">
        <span className="text-label font-semibold uppercase leading-[normal] tracking-[0.03em] text-ink3">
          Mode
        </span>
        <ModeToggle />
      </div>

      {/* Nav */}
      <div className="flex-1 overflow-y-auto px-3 pb-2.5">
        <NavList activePath={pathname} onNavigate={go} />
      </div>

      {/* Footer — workspace identity + single 34×34 theme control */}
      <div className="flex items-center gap-2.5 border-t border-line2 px-3.5 py-3">
        <span className="flex size-[30px] shrink-0 items-center justify-center border border-line2 bg-panel text-meta font-semibold text-ink2">
          NS
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-meta font-semibold leading-[normal]">Local workspace</div>
          <div className="text-label font-semibold uppercase leading-[normal] tracking-[0.03em] text-ink3">
            This browser
          </div>
        </div>
        <ThemeToggle className="size-[34px]" />
      </div>
    </div>
  );
}
