"use client";

// Shared navigation list body (T08). One flat, always-open list rendered inside
// AppSideNav — used verbatim by both the desktop rail and the mobile drawer, so
// their nav hierarchy can never drift (MAJOR 3).
//
// Presentation matches the prototype SideNav (SideNav.dc.html:29-46): flat,
// always-visible groups (no collapsibles), a headerless Home group followed by
// the labeled SET UP / OUTPUT / SYSTEM groups, and per-row ordering of a 20px
// centered icon → flexible label → trailing metadata cluster (audit MAJOR 2). A
// full-row brand-tint active state and a `panel` hover are kept from the prior
// verified-conformance pass.
//
// Typography (audit MAJOR 3): inactive rows 500, active rows 600, with an
// explicit ~42px row height (10px 12px padding retained). The trailing cluster
// holds a live scenario count (hidden when zero) and, when present, the Guided
// step number — count immediately before step (audit MAJOR 2).

import { NAV_GROUPS, type NavItem } from "./nav-config";
import { navCountFor, useScenarioSummary } from "@/components/home/scenario-summary";
import { cn } from "@/lib/utils";

export function NavList({
  activePath,
  onNavigate,
}: {
  activePath: string;
  onNavigate: (path: string) => void;
}) {
  const summary = useScenarioSummary();

  return (
    <nav data-testid="sidebar-nav" aria-label="Main navigation" className="flex flex-col py-1">
      {NAV_GROUPS.map((group, idx) => (
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
              count={item.countKey ? navCountFor(summary, item.countKey) : 0}
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
  count,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  count: number;
  onClick: () => void;
}) {
  const Icon = item.icon;
  const hasTrailing = count > 0 || item.guidedStep != null;
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
          {count > 0 ? (
            <span
              data-testid={`nav-count-${item.path}`}
              aria-label={`${count} ${item.label.toLowerCase()}`}
            >
              {count}
            </span>
          ) : null}
          {item.guidedStep != null ? (
            <span data-testid={`nav-step-${item.path}`} aria-label={`Step ${item.guidedStep}`}>
              {item.guidedStep}
            </span>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}
