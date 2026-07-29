"use client";

import * as React from "react";
import { Separator as BaseSeparator } from "@base-ui/react/separator";
import { cn } from "@/lib/utils";

// Base UI Separator on the hairline token. Orientation drives the axis from the
// same prop the primitive receives; the preset's `data-horizontal:` / `data-vertical:`
// variants are NOT used because Base UI publishes orientation as
// `data-orientation="horizontal|vertical"` (SeparatorDataAttributes), not as bare
// boolean attributes, so those variants would silently match nothing.
export function Separator({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof BaseSeparator>) {
  return (
    <BaseSeparator
      data-slot="separator"
      orientation={orientation}
      className={cn(
        "shrink-0 rounded-none bg-line2",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className,
      )}
      {...props}
    />
  );
}
