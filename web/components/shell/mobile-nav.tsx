"use client";

// Mobile navigation drawer (T08). Below the 920px `nav` breakpoint the sidebar is
// hidden and a hamburger button in the top bar opens this side-sheet. It renders
// the same grouped nav as the sidebar, routed through the same guarded-navigation
// gate, and closes on navigation so the user lands on the target page dismissed.
//
// Implemented with Base UI's Dialog (the ticket allows "drawer (collapsible/
// dialog)") styled as a left-anchored sheet: Dialog gives modal focus-trap +
// scroll-lock + Esc/backdrop dismiss with pure-CSS positioning, avoiding the
// swipe-physics / snap-point CSS the Drawer primitive requires. The slide-in uses
// Base UI's `data-starting-style` / `data-ending-style` transition attributes.

import { useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { NAV_GROUPS } from "./nav-config";
import { ModeToggle } from "./mode-toggle";
import { useGuardedNavigation } from "./use-guarded-navigation";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { FaBars, FaXmark } from "@/components/icons";
import { Button } from "@/components/ui/button";

export function MobileNav() {
  const [open, setOpen] = useState(false);
  const { navigate } = useGuardedNavigation();
  const pathname = usePathname();

  const handleNavigate = (path: string) => {
    setOpen(false);
    navigate(path);
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Open navigation menu"
        data-testid="mobile-nav-trigger"
        onClick={() => setOpen(true)}
        // Chrome top bar: `ghost`'s text-ink is invisible on dark chrome. `onbrand`
        // is #fff in both themes (on-ink would collapse to chrome in dark).
        className="text-onbrand hover:bg-onbrand/10"
      >
        <FaBars />
      </Button>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 transition-opacity duration-fast data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          data-testid="mobile-nav-drawer"
          className={cn(
            "fixed inset-y-0 left-0 z-50 flex w-[var(--sidebar-w)] max-w-[85vw] flex-col gap-4 overflow-y-auto border-r border-line bg-sidebar p-4 shadow-side outline-none",
            "transition-transform duration-fast data-[ending-style]:-translate-x-full data-[starting-style]:-translate-x-full",
          )}
        >
          <div className="flex items-center justify-between">
            <Dialog.Title className="font-heading text-h3 font-semibold tracking-tight">
              Nurse Scheduler
            </Dialog.Title>
            {/* Explicit accessible close inside the modal popup (Base UI 1.6.0
                guidance) — Escape/backdrop also dismiss, but touch screen-reader
                users need a labeled control. */}
            <Dialog.Close
              aria-label="Close navigation menu"
              data-testid="mobile-nav-close"
              className="flex size-8 items-center justify-center text-ink2 outline-none hover:bg-panel hover:text-ink focus-visible:ring-2 focus-visible:ring-brand"
            >
              <FaXmark className="size-4" />
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">Application navigation</Dialog.Description>

          {/* Mobile mode control — the top-bar ModeToggle is hidden below 640px,
              so the Guided/Advanced lens must be reachable here on phones. */}
          <div className="flex flex-col gap-1.5">
            <span className="px-1 text-label uppercase tracking-[0.03em] text-ink3">Mode</span>
            <ModeToggle />
          </div>

          <nav aria-label="Mobile navigation" className="flex flex-col gap-4">
            {NAV_GROUPS.map((group) => (
              <div
                key={group.id}
                data-testid={`mobile-nav-group-${group.id}`}
                className="flex flex-col gap-1"
              >
                <span className="px-3 py-1 text-label uppercase tracking-[0.03em] text-ink3">
                  {group.label}
                </span>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active = pathname === item.path;
                  return (
                    <button
                      key={item.path}
                      type="button"
                      onClick={() => handleNavigate(item.path)}
                      aria-current={active ? "page" : undefined}
                      data-testid={`mobile-nav-link-${item.path}`}
                      className={cn(
                        "flex items-center gap-2.5 px-3 py-2 text-left text-body transition-colors",
                        active
                          ? "bg-brandtint font-medium text-brandink"
                          : "text-ink2 hover:bg-panel hover:text-ink",
                      )}
                    >
                      <Icon className="size-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
