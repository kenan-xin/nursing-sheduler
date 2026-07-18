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
// Typography (audit MAJOR 3): inactive rows 500, active rows 600, with an
// explicit ~42px row height (10px 12px padding retained). DL12 §2: the
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
}: {
  activePath: string;
  onNavigate: (path: string) => void;
}) {
  const mode = useAppMode();
  const groups = getNavGroupsForMode(mode);

  return (
    <nav data-testid="sidebar-nav" aria-label="Main navigation" className="flex flex-col py-1">
      {groups.map((group, idx) => (
        <div
          key={group.id}
          data-testid={`nav-group-${group.id}`}
          className={cn("flex flex-col", idx > 0 && "mt-2.5")}
        >
          {group.label ? (
            <div
              data-testid={`nav-group-label-${group.id}`}
              className="px-2 py-1.5 text-label font-semibold uppercase leading-[normal] tracking-[0.03em] text-ink3"
            >
              {group.label}
            </div>
          ) : null}
          {group.items.map((item) => (
            <NavLink
              key={item.path}
              item={item}
              active={activePath === item.path}
              showStep={mode === "guided"}
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
  onClick,
}: {
  item: NavItem;
  active: boolean;
  showStep: boolean;
  onClick: () => void;
}) {
  const Icon = item.icon;
  const hasTrailing = showStep && item.guidedStep != null;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      data-testid={`nav-link-${item.path}`}
      className={cn(
        "flex items-center gap-2.5 px-3 py-2.5 text-left text-body leading-[normal] outline-none transition-colors focus-visible:ring-brand focus-visible:ring-inset focus-visible:ring-2",
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
        <Icon className="size-4" />
      </span>
      <span className="flex-1 truncate">{item.label}</span>
      {hasTrailing ? (
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
