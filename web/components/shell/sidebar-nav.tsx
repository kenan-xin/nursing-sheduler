"use client";

// Desktop sidebar navigation (T08). Renders the grouped nav (model→rules→
// generate→save) with the active route highlighted. Every nav click routes
// through the guarded navigation hook so the dirty-guard prompt fires before
// any loss (acceptance row 2). Nav groups are collapsible via Base UI
// Collapsible so long groups (Rules) don't crowd the panel.

import { Collapsible } from "@base-ui/react/collapsible";
import { NAV_GROUPS, type NavItem } from "./nav-config";
import { useGuardedNavigation } from "./use-guarded-navigation";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { FaChevronRight } from "@/components/icons";

export function SidebarNav() {
  const { navigate } = useGuardedNavigation();
  const pathname = usePathname();

  return (
    <nav data-testid="sidebar-nav" aria-label="Main navigation" className="flex flex-col gap-4">
      {NAV_GROUPS.map((group) => (
        <Collapsible.Root
          key={group.id}
          defaultOpen
          data-testid={`nav-group-${group.id}`}
          className="flex flex-col gap-1"
        >
          <Collapsible.Trigger className="group flex items-center justify-between px-3 py-1 text-label uppercase tracking-[0.03em] text-ink3 hover:text-ink2">
            <span>{group.label}</span>
            {/* Closed → chevron points right; open → rotates 90° to point down.
                Base UI sets `data-panel-open` on the trigger while expanded. */}
            <FaChevronRight
              data-testid={`nav-group-${group.id}-chevron`}
              className="size-3 text-ink3 transition-transform duration-fast group-data-[panel-open]:rotate-90"
            />
          </Collapsible.Trigger>
          <Collapsible.Panel className="flex flex-col">
            {group.items.map((item) => (
              <NavLink
                key={item.path}
                item={item}
                active={pathname === item.path}
                onClick={() => navigate(item.path)}
              />
            ))}
          </Collapsible.Panel>
        </Collapsible.Root>
      ))}
    </nav>
  );
}

function NavLink({
  item,
  active,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      data-testid={`nav-link-${item.path}`}
      className={cn(
        "flex items-center gap-2.5 border-l-2 px-3 py-1.5 text-left text-body transition-colors",
        active
          ? "border-brand bg-brandtint text-brandink font-medium"
          : "border-transparent text-ink2 hover:bg-panel hover:text-ink",
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="truncate">{item.label}</span>
    </button>
  );
}
