"use client";

// Shared navigation list body (T08, mode-filtered by T08d). One flat,
// always-open list rendered inside AppSideNav — used verbatim by both the
// desktop rail and the mobile drawer, so their nav hierarchy can never drift
// (MAJOR 3). It reuses `getNavGroupsForMode` (nav-config.ts) — the same
// filtered registry Home and route validity read — so the sidebar can never
// list a destination Home/crumbs/validity disagree about.
//
// Presentation matches the prototype SideNav (SideNav.dc.html:29-46): flat,
// always-visible groups (no collapsibles), a headerless Home group followed by
// the labeled SET UP / CONSTRAINTS / OUTPUT / SYSTEM groups (Constraints only
// in Advanced), and per-row ordering of a 20px centered icon → flexible label →
// trailing metadata cluster (audit MAJOR 2). A full-row brand-tint active
// state and a `panel` hover are kept from the prior verified-conformance pass.
//
// Typography (audit MAJOR 3): inactive rows 500, active rows 600, with an explicit
// row height from `leading-[normal]` + `py-2.5` — 38px, not the prototype's 42,
// since the padding is spacing-derived and carries the 0.9 baseline (globals.css). DL12 §2: the
// trailing cluster holds only the Guided workflow step, and only in Guided
// mode — live scenario counts stay on Home rather than rendering a second,
// ambiguous number, and Advanced rows never show a Guided step number since
// Advanced has no workflow to number.

import { useAppMode } from "@/lib/mode/use-mode";
import { getNavGroupsForMode, type NavItem } from "./nav-config";
import { cn } from "@/lib/utils";

export function NavList({
  activePath,
  onNavigate,
  collapsed = false,
}: {
  activePath: string;
  onNavigate: (path: string) => void;
  /** Desktop compact rail (G8). The mobile drawer always passes `false`. */
  collapsed?: boolean;
}) {
  const mode = useAppMode();
  const groups = getNavGroupsForMode(mode);

  return (
    <nav
      data-testid="sidebar-nav"
      data-collapsed={collapsed ? "true" : "false"}
      aria-label="Main navigation"
      className={cn("flex flex-col py-1", collapsed && "items-center")}
    >
      {groups.map((group, idx) => (
        <div
          key={group.id}
          data-testid={`nav-group-${group.id}`}
          className={cn(
            "flex flex-col",
            collapsed ? "w-full items-center gap-1" : "",
            idx > 0 && (collapsed ? "mt-1.5" : "mt-2.5"),
          )}
        >
          {group.label ? (
            collapsed ? (
              // The compact rail keeps the GROUPING but drops the words: a
              // hairline `--line2` rule that still carries its heading as an
              // accessible name, so the structure survives at 60px rather than
              // being flattened into one undifferentiated column of icons
              // (SideNav.dc.html `showRule`).
              <div
                data-testid={`nav-group-label-${group.id}`}
                role="separator"
                aria-label={group.label}
                title={group.label}
                className="my-1.5 h-px w-full bg-line2"
              />
            ) : (
              <div
                data-testid={`nav-group-label-${group.id}`}
                className="px-2 py-1.5 text-label font-semibold uppercase leading-[normal] tracking-[0.03em] text-ink3"
              >
                {group.label}
              </div>
            )
          ) : null}
          {group.items.map((item) => (
            <NavLink
              key={item.path}
              item={item}
              active={activePath === item.path}
              showStep={mode === "guided"}
              collapsed={collapsed}
              onClick={() => onNavigate(item.path)}
            />
          ))}
        </div>
      ))}
    </nav>
  );
}

function NavLink({
  item,
  active,
  showStep,
  collapsed,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  showStep: boolean;
  collapsed: boolean;
  onClick: () => void;
}) {
  const Icon = item.icon;
  const hasTrailing = showStep && item.guidedStep != null;
  // The compact row's whole visible content is a glyph, so the label has to be
  // carried some other way. The prototype's tip — "Dates · step 1" — becomes BOTH
  // the `title` (a visible tooltip for pointer users) and the accessible name,
  // and the step ordinal is only ever appended in Guided mode, where it exists.
  const compactName =
    hasTrailing && item.guidedStep != null ? `${item.label} · step ${item.guidedStep}` : item.label;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      aria-label={collapsed ? compactName : undefined}
      title={collapsed ? compactName : undefined}
      data-testid={`nav-link-${item.path}`}
      className={cn(
        // The coarse-pointer floor is on the real control, never a pseudo-element
        // hitbox (DESIGN.md §5). The precise-pointer row keeps its spacing-derived
        // height; only a touch device grows it to the 44px minimum.
        //
        // `leading-[normal]` MUST stay after `text-body` in the merged string.
        // tailwind-merge treats `font-size` as conflicting with `leading` (a
        // Tailwind `text-sm/6` can set both), so a `leading-*` that lands EARLIER
        // than the font size is silently dropped — which is exactly what grew the
        // row from 38px to 41px when this recipe was first split in two.
        "flex items-center outline-none transition-colors pointer-coarse:min-h-touch focus-visible:ring-brand focus-visible:ring-inset focus-visible:ring-2",
        collapsed
          ? // 40×38 centred icon button at the control radius (SideNav.dc.html
            // collapsed `style`). A pill would read as a bare circle at this size;
            // DESIGN.md reserves the pill for full-width nav rows.
            "h-[38px] w-[40px] shrink-0 justify-center rounded-control leading-[normal] pointer-coarse:min-w-touch"
          : "gap-2.5 rounded-pill px-3 py-2.5 text-left text-body leading-[normal]",
        active
          ? "bg-brandtint font-semibold text-brandink"
          : "font-medium text-ink2 hover:bg-panel hover:text-ink",
      )}
    >
      {/* 20px centered icon column (SideNav.dc.html:37) — no leading step spacer, so
          non-step rows are no longer shifted right. */}
      <span
        className={cn("flex w-5 shrink-0 justify-center", active ? "text-brandink" : "text-ink3")}
      >
        <Icon className="size-4" aria-hidden />
      </span>
      {collapsed ? null : <span className="flex-1 truncate">{item.label}</span>}
      {!collapsed && hasTrailing ? (
        <span
          className={cn(
            "flex shrink-0 items-center gap-1 font-mono text-label font-semibold",
            active ? "text-brandink" : "text-ink3",
          )}
        >
          <span data-testid={`nav-step-${item.path}`} aria-label={`Step ${item.guidedStep}`}>
            {item.guidedStep}
          </span>
        </span>
      ) : null}
    </button>
  );
}
