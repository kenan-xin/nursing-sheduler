"use client";

// Mobile navigation drawer (T08, MAJOR 3). Below the 920px `nav` breakpoint the
// desktop rail is hidden and this hamburger (in the top bar) opens a left-anchored
// sheet. The sheet renders the SAME AppSideNav composition as the desktop rail —
// brand, mode, nav, footer — so the two never diverge.
//
// Drawer metrics + motion match the prototype (audit MAJOR 6 / m8,
// Nurse Scheduling.dc.html:113-117): 250px / max-width 84vw (the desktop rail
// stays 280px), a 50% rgba(8,10,14) scrim, and the 220ms base slide.
//
// Accessible close (audit m8): rather than overlaying a close-X on top of the
// brand lockup, the close control is rendered in AppSideNav's reserved
// `headerActions` slot — a trailing position in the brand header that is
// mobile-only. Escape, backdrop dismiss, focus trapping, and close-after-nav
// already work through Base UI.
//
// Implemented with Base UI's Dialog styled as a sheet: it provides the modal
// focus-trap, scroll-lock and Esc/backdrop dismiss, with pure-CSS slide-in via
// the `data-starting-style` / `data-ending-style` transition attributes.

import { useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { AppSideNav } from "./app-side-nav";
import { cn } from "@/lib/utils";
import { FaBars, FaXmark } from "@/components/icons";

export function MobileNav() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger
        aria-label="Open navigation menu"
        data-testid="mobile-nav-trigger"
        className="flex size-10 items-center justify-center border border-line bg-transparent text-ink outline-none hover:bg-panel focus-visible:ring-2 focus-visible:ring-brand [&_svg]:size-4"
      >
        <FaBars />
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-[rgba(8,10,14,0.5)] transition-opacity duration-fast data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          data-testid="mobile-nav-drawer"
          className={cn(
            "fixed inset-y-0 left-0 z-50 flex w-[250px] max-w-[84vw] flex-col bg-sidebar shadow-side outline-none",
            "transition-transform duration-base data-[ending-style]:-translate-x-full data-[starting-style]:-translate-x-full",
          )}
        >
          <Dialog.Title className="sr-only">Navigation</Dialog.Title>
          <Dialog.Description className="sr-only">Application navigation</Dialog.Description>
          <AppSideNav
            onAfterNavigate={() => setOpen(false)}
            headerActions={
              <Dialog.Close
                aria-label="Close navigation menu"
                data-testid="mobile-nav-close"
                className="flex size-8 items-center justify-center text-ink2 outline-none hover:bg-panel hover:text-ink focus-visible:ring-2 focus-visible:ring-brand"
              >
                <FaXmark className="size-4" />
              </Dialog.Close>
            }
          />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
