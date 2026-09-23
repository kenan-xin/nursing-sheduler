"use client";

import * as React from "react";
import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { cn } from "@/lib/utils";

// Base UI Switch on the v2 tokens. Two things are load-bearing here.
//
// 1. The COARSE-POINTER TARGET IS THE REAL CONTROL. A 36x20 track cannot be a
//    44x44 touch target, and T8 forbids faking one with an overlapping
//    pseudo-element (which is what the shadcn preset's `after:-inset-*` does).
//    So Base UI's Root — the element that actually receives the press — grows to
//    `size-touch` on a coarse pointer, and the small track visual is a child
//    centred inside it. On a precise pointer the Root is the track's own size.
// 2. The track therefore reads Root's state through Base UI's `data-checked` /
//    `data-unchecked` attributes via `group/switch`, so the primitive's state
//    contract stays the single source of truth for the visual.
//
// Geometry: the track is a pill (a segmented/status control per DESIGN.md §5) and
// the thumb is a circle. The thumb's elevation is `--sh-1`, not Tailwind's
// untokened `shadow-sm`.
export function Switch({ className, ...props }: React.ComponentProps<typeof BaseSwitch.Root>) {
  return (
    <BaseSwitch.Root
      data-slot="switch"
      className={cn(
        "group/switch relative inline-flex shrink-0 items-center justify-center",
        "pointer-coarse:size-touch",
        "focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-brand",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <span
        data-slot="switch-track"
        className={cn(
          "pointer-events-none inline-flex h-5 w-9 shrink-0 items-center rounded-pill border p-0.5",
          "transition-colors duration-fast",
          "group-data-[checked]/switch:border-brand group-data-[checked]/switch:bg-brand",
          "group-data-[unchecked]/switch:border-line group-data-[unchecked]/switch:bg-panel",
        )}
      >
        <BaseSwitch.Thumb
          data-slot="switch-thumb"
          className={cn(
            "block size-3.5 rounded-full bg-surface2 shadow-1 transition-transform duration-fast",
            "data-[checked]:translate-x-4 data-[unchecked]:translate-x-0",
          )}
        />
      </span>
    </BaseSwitch.Root>
  );
}
