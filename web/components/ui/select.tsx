"use client";

// The one native-select treatment for the whole app — the design prototype's
// select (ScreenRules.dc.html:38-40): `appearance:none` plus an absolutely
// positioned triangle caret drawn in reserved padding.
//
// Why the caret is ours and not the browser's: Chrome paints the built-in arrow
// INSIDE the element's padding-right, so a select styled `px-2` like the rest of
// our controls has its arrow overlap that 8px and land flush against the border —
// the crowded caret reported on the shift-type time fields. Reserving the space
// (pr-7) and drawing the caret ourselves makes the gap explicit, and matches the
// prototype's caret in both themes instead of inheriting the platform chevron.
//
// The reserved right padding is an INVARIANT, so it is set as an inline style rather
// than a utility class — the one mechanism a caller's `className` cannot defeat.
// Class-based attempts both fail: `cn("pr-7", …, "px-3")` drops `pr-7` outright,
// and merging `pr-7` last only yields `px-3 pr-7`, leaving the winner to stylesheet
// source order rather than anything this component controls. Either way the label
// slides back under the caret — the exact bug this file exists to fix, and `px-3` is
// what one call site already passed. The value tracks `--spacing` (which carries
// the 0.9 baseline — see globals.css) exactly as `pr-7` would. `select.test.tsx`
// pins the contract.

import * as React from "react";
import { cn } from "@/lib/utils";

export interface SelectProps extends React.ComponentPropsWithoutRef<"select"> {
  /** Stretch both the positioning wrapper and the select to the row width. */
  fullWidth?: boolean;
  /** Extra classes for the positioning wrapper (layout: flex-none, min-w-0, …). */
  wrapperClassName?: string;
}

/** The caret's reserved space — `pr-7` in inline form, carried via --spacing. */
const CARET_GUTTER = "calc(var(--spacing) * 7)";

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, fullWidth, wrapperClassName, style, ...props },
  ref,
) {
  return (
    <span
      className={cn("relative inline-flex items-center", fullWidth && "w-full", wrapperClassName)}
    >
      <select
        ref={ref}
        className={cn(
          "peer h-9 cursor-pointer appearance-none rounded-none border border-line bg-surface pl-2 text-body text-ink disabled:cursor-not-allowed disabled:opacity-60",
          fullWidth && "w-full",
          className,
        )}
        // Caller style first: the caret gutter is not theirs to drop.
        style={{ ...style, paddingRight: CARET_GUTTER }}
        {...props}
      />
      {/* Prototype caret: a 10×6 solid triangle in --ink3, 10px from the edge. It
          fades with the control when disabled (`peer-disabled`) — the native arrow
          it replaces was part of the select and dimmed with it, so a sibling left
          at full contrast would read as an enabled caret on a greyed-out field.

          Centred with -translate-y-1/2, NOT the prototype's translateY(-25%): the
          triangle's box is 6px tall (all border-top), so -25% lifts it 1.5px where
          centring needs 3px — measurably 1.5px below the value beside it in all
          three selects. The prototype's own value is off-centre. */}
      <span
        aria-hidden
        className="pointer-events-none absolute right-2.5 top-1/2 size-0 -translate-y-1/2 border-x-[5px] border-x-transparent border-t-[6px] border-t-ink3 peer-disabled:opacity-60"
      />
    </span>
  );
});
