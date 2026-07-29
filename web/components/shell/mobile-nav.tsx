"use client";

// Mobile navigation drawer (T08, MAJOR 3). Below the 920px `nav` breakpoint the
// desktop rail is hidden and this hamburger (in the top bar) opens a left-anchored
// sheet. The sheet renders the SAME AppSideNav composition as the desktop rail —
// brand, mode, nav, footer — so the two never diverge.
//
// Drawer metrics + motion match the prototype (audit MAJOR 6 / m8,
// Nurse Scheduling.dc.html:113-117): 250px / max-width 84vw (the desktop rail
// stays 280px), the canonical `--scrim` backdrop, and the 220ms base slide.
//
// Accessible close (audit m8): rather than overlaying a close-X on top of the
// brand lockup, the close control is rendered in AppSideNav's reserved
// `headerActions` slot — a trailing position in the brand header that is
// mobile-only. Escape, backdrop dismiss, focus trapping, and close-after-nav
// already work through Base UI.
//
// Implemented with the shared shadcn Base UI `Dialog` shell's `side` variant: it
// provides the same portal, canonical `bg-scrim` backdrop, modal focus-trap,
// scroll-lock and Esc/backdrop dismiss as every other overlay, plus the drawer's
// own surface role (`--sidebar` tone, `shadow-side`, square) and pure-CSS
// slide-in via the `data-starting-style` / `data-ending-style` attributes.

import { useState } from "react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AppSideNav } from "./app-side-nav";
import { FaBars, FaXmark } from "@/components/icons";

export function MobileNav() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        aria-label="Open navigation menu"
        data-testid="mobile-nav-trigger"
        className="flex size-10 items-center justify-center border border-line bg-transparent text-ink outline-none hover:bg-panel focus-visible:ring-2 focus-visible:ring-brand [&_svg]:size-4"
      >
        <FaBars />
      </DialogTrigger>
      <DialogContent variant="side" showCloseButton={false} data-testid="mobile-nav-drawer">
        <DialogTitle className="sr-only">Navigation</DialogTitle>
        <DialogDescription className="sr-only">Application navigation</DialogDescription>
        <AppSideNav
          onAfterNavigate={() => setOpen(false)}
          headerActions={
            <DialogClose
              aria-label="Close navigation menu"
              data-testid="mobile-nav-close"
              render={<Button variant="ghost" size="icon" />}
            >
              <FaXmark />
            </DialogClose>
          }
        />
      </DialogContent>
    </Dialog>
  );
}
