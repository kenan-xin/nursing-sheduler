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
// one theme control, matching SideNav.dc.html:64-66. v2 sizes that control at
// 36px, which is the shared `icon` control token, so the v1-era 34px override
// is gone. Density was a prototype preview-only prop and is no longer chrome
// (bmw.8 removed it entirely); accent remains exposed on the /design-system page.
//
// `headerActions` reserves a trailing slot in the brand header for the mobile
// drawer's accessible close control (audit m8), without overlaying the brand
// lockup and without appearing on the desktop rail.
//
// COMPACT RAIL (G8). `collapsed` renders the prototype's 60px icon rail
// (SideNav.dc.html, `collapsed` branch): the brand mark alone with the product
// name on its `title`, the Guided/Advanced segmented control folded into one
// GUI/ADV pill, group headings replaced by `--line2` separators that keep their
// heading as a title, and a footer holding only the theme control. It is a
// DESKTOP-only preference — the mobile drawer passes `collapsed={false}`
// explicitly and can never be narrowed by it.

import { type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useGuardedNavigation } from "./use-guarded-navigation";
import { NavList } from "./sidebar-nav";
import { ModeToggle } from "./mode-toggle";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { FaDiagramProject } from "@/components/icons";
import { cn } from "@/lib/utils";

const BRAND_TITLE = "Rota · Nurse Scheduling";

export function AppSideNav({
  onAfterNavigate,
  headerActions,
  collapsed = false,
}: {
  onAfterNavigate?: () => void;
  headerActions?: ReactNode;
  /** Desktop compact rail. The mobile drawer always passes `false`. */
  collapsed?: boolean;
}) {
  const pathname = usePathname();
  const { navigate } = useGuardedNavigation();

  const go = (path: string) => {
    navigate(path);
    onAfterNavigate?.();
  };

  return (
    <div
      data-testid="app-side-nav"
      data-collapsed={collapsed ? "true" : "false"}
      className="flex h-full flex-col overflow-hidden"
    >
      {/* Brand */}
      <div
        className={cn(
          "flex items-center border-b border-line2 pb-3.5 pt-4.5",
          collapsed ? "justify-center px-2.5" : "gap-2.5 px-4",
        )}
      >
        {/* `--chrome` aliases the live `--brand`, so the app mark's foreground is
            the accent's own paired `--onbrand` — the pair chrome-contrast.test.ts
            audits for AA. The ink ramp's ON-colour, which this carried, belongs
            to the v1 dark-chrome bar and is a different fill's pairing.

            Compact: the mark carries the product name on `title` (the prototype's
            `brandTitle`) plus an sr-only copy, so the rail is never a nameless
            glyph for a screen reader. */}
        <span
          data-testid="sidebar-brand-mark"
          title={collapsed ? BRAND_TITLE : undefined}
          className="flex size-[32px] shrink-0 items-center justify-center rounded-chip bg-chrome text-[14px] text-onbrand"
        >
          <FaDiagramProject aria-hidden />
          {collapsed ? <span className="sr-only">{BRAND_TITLE}</span> : null}
        </span>
        {collapsed ? null : (
          <div className="min-w-0 flex-1">
            <div className="font-heading text-title font-bold leading-none tracking-[-0.015em]">
              Rota
            </div>
            <div className="mt-[3px] text-label font-semibold uppercase leading-[normal] tracking-[0.03em] text-ink3">
              Nurse Scheduling
            </div>
          </div>
        )}
        {headerActions ? <div className="flex shrink-0 items-center">{headerActions}</div> : null}
      </div>

      {/* Mode. The "Mode" caption is dropped when compact — the control's own
          title/accessible name carries it, and a 60px rail has no room for a
          label above a 40px pill. */}
      <div
        className={cn(
          "flex flex-col pb-2.5 pt-3.5",
          collapsed ? "items-center px-2.5" : "gap-1.5 px-4",
        )}
      >
        {collapsed ? null : (
          <span className="text-label font-semibold uppercase leading-[normal] tracking-[0.03em] text-ink3">
            Mode
          </span>
        )}
        <ModeToggle compact={collapsed} />
      </div>

      {/* Nav */}
      <div className={cn("flex-1 overflow-y-auto pb-2.5", collapsed ? "px-2.5" : "px-3")}>
        <NavList activePath={pathname} onNavigate={go} collapsed={collapsed} />
      </div>

      {/* Footer — workspace identity + the single theme control. The identity
          cluster is the prototype's panel-fill footer block (SideNav.dc.html:64),
          the honest product stand-in for its autosave indicator (MAJOR 3: no
          account backend). Two things about it are deliberate:

          The prototype's leading status dot is NOT carried over. It is decorative
          here — there is no autosave state behind it — and live persistence state
          is F2's PersistenceStatus in the top bar, which this must not shadow
          with a second, always-green signal.

          Both identity lines are kept and neither may ellipsize. The prototype's
          own footer copy ("Local draft · autosaved") is one short phrase, so its
          single-line pill fits it; the product's identity is two facts and does
          NOT fit on one line at either shipped width — 280px desktop rail or
          250px drawer. So the block keeps the panel fill and stacks the two
          lines, and takes the control radius rather than the pill: a static
          identity well is an inner box, not a button, nav item or segmented
          control, which is what DESIGN.md §5 reserves the pill for. Shortening or
          merging the copy is not available — it is product copy.

          `whitespace-nowrap` is load-bearing for the guard in
          app-shell-rebuild.spec.ts: without it the text would wrap and
          `scrollWidth <= clientWidth` would pass vacuously instead of proving
          the line actually fits.

          Compact (G8): the identity well is dropped and the footer keeps only the
          theme control, exactly as the prototype's collapsed footer does. Two
          stacked lines of copy that already need 280px cannot be truncated into
          60px without becoming unreadable, and the identity is orientation, not
          an action — it is the one thing a rail can afford to drop. */}
      <div
        className={cn(
          "flex items-center border-t border-line2 py-3",
          collapsed ? "justify-center px-2.5" : "gap-2.5 px-3.5",
        )}
      >
        {collapsed ? null : (
          <div
            data-testid="sidebar-identity"
            className="flex min-w-0 flex-1 flex-col rounded-control bg-panel px-3 py-2"
          >
            <span
              data-testid="sidebar-identity-name"
              className="overflow-hidden whitespace-nowrap text-meta font-semibold leading-[normal]"
            >
              Local workspace
            </span>
            <span
              data-testid="sidebar-identity-scope"
              className="overflow-hidden whitespace-nowrap text-label font-semibold uppercase leading-[normal] tracking-[0.03em] text-ink3"
            >
              This browser
            </span>
          </div>
        )}
        <ThemeToggle />
      </div>
    </div>
  );
}
