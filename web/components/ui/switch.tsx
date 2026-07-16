"use client";

import * as React from "react";
import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { cn } from "@/lib/utils";

// Base UI Switch restyled to the design tokens. Square corners (radius 0); the
// track fills with the brand token when checked, panel otherwise. Base UI exposes
// on/off via the `data-checked` / `data-unchecked` attributes on both parts.
export function Switch({ className, ...props }: React.ComponentProps<typeof BaseSwitch.Root>) {
  return (
    <BaseSwitch.Root
      data-slot="switch"
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-none border border-line p-0.5 transition-colors duration-fast outline-none",
        "focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-0",
        "data-[checked]:border-brand data-[checked]:bg-brand data-[unchecked]:bg-panel",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <BaseSwitch.Thumb
        data-slot="switch-thumb"
        className={cn(
          "block size-3.5 rounded-none bg-surface shadow-sm transition-transform duration-fast",
          "data-[checked]:translate-x-4 data-[unchecked]:translate-x-0",
        )}
      />
    </BaseSwitch.Root>
  );
}
