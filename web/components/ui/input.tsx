import * as React from "react";
import { cn } from "@/lib/utils";

// Square-cornered input on the design tokens. Focus outline is handled globally
// (focus-visible in globals.css); the ring here reinforces it for the field box.
export function Input({ className, type = "text", ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-9 w-full rounded-none border border-line bg-surface px-3 py-1 text-body text-ink",
        "placeholder:text-faint",
        "focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30 outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
