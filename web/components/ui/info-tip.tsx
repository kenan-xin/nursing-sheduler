"use client";

import * as React from "react";
import { FaCircleInfo } from "@/components/icons";
import { cn } from "@/lib/utils";

/**
 * A small inline help affordance (design prototype `InfoTip.dc.html`): an info
 * icon that reveals its help text on hover AND keyboard focus. Accessible — a
 * focusable button carries the text as its accessible name (aria-label + native
 * title), and the visible bubble is exposed with `role="tooltip"`.
 *
 * v2 treatment: the bubble is an `--ink` fill with `--on-ink` text on the chip
 * radius at `--sh-2`, centred under the trigger, at the prototype's
 * `min(250px, 62vw)` width. The trigger tints to `--brandink` while open. It is a
 * real control, so it reaches the 44x44 coarse-pointer minimum on itself rather
 * than through a pseudo-element hitbox — the 16px glyph just centres inside it.
 */
export function InfoTip({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <span className="relative inline-flex align-middle">
      <button
        type="button"
        aria-label={`${label}: ${text}`}
        title={text}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          e.preventDefault();
          setOpen((o) => !o);
        }}
        className={cn(
          "inline-flex size-4 shrink-0 items-center justify-center rounded-full",
          "pointer-coarse:size-touch",
          "transition-colors duration-fast",
          open ? "text-brandink" : "text-ink3",
          "hover:text-brandink focus-visible:text-brandink",
          "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand",
        )}
      >
        <FaCircleInfo aria-hidden className="size-3.5" />
      </button>
      {open && (
        <span
          role="tooltip"
          data-slot="info-tip"
          className={cn(
            "absolute left-1/2 top-[calc(100%+7px)] z-50 w-[min(250px,62vw)] -translate-x-1/2",
            "rounded-chip bg-ink px-3 py-2 text-label font-medium normal-case leading-relaxed",
            "tracking-normal text-on-ink shadow-2",
            "whitespace-normal text-left",
          )}
        >
          {text}
        </span>
      )}
    </span>
  );
}
