"use client";

import * as React from "react";
import { FaCircleInfo } from "@/components/icons";

/**
 * A small inline help affordance (design prototype "InfoTip"): an info icon that
 * reveals its help text on hover AND keyboard focus. Accessible — a focusable
 * button carries the text as its accessible name (aria-label + native title), and
 * the visible bubble is exposed with role="tooltip".
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
        className="inline-flex size-4 items-center justify-center rounded-full text-ink3 hover:text-ink2 focus-visible:text-ink2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand"
      >
        <FaCircleInfo aria-hidden className="size-3.5" />
      </button>
      {open && (
        <span
          role="tooltip"
          className="absolute left-0 top-[calc(100%+6px)] z-50 w-64 whitespace-normal border border-line2 bg-surface px-3 py-2 text-label font-normal normal-case leading-relaxed tracking-normal text-ink2 shadow-dialog"
        >
          {text}
        </span>
      )}
    </span>
  );
}
