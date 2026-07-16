import * as React from "react";
import { cn } from "@/lib/utils";

// Uppercase eyebrow label per the README (+.03em tracking on labels/eyebrows).
export function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="label"
      className={cn(
        "text-label font-semibold uppercase tracking-[0.03em] text-ink3",
        "peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
