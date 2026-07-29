import * as React from "react";
import { cn } from "@/lib/utils";

// v2 field (DESIGN.md §5 Inputs): control radius (12px), L1 `--surface` fill, a
// `--line` hairline, and the absolute 36px control height — which grows to a real
// 44px on a coarse pointer via `pointer-coarse:min-h-touch` on the input itself,
// not a pseudo-element hitbox.
//
// Focus REINFORCES the global `:focus-visible` outline from globals.css rather
// than replacing it: the border shifts to `--brand` and a soft accent ring is
// added, and `outline-none` is deliberately absent so the 2px brand outline still
// paints.
export function Input({ className, type = "text", ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-control w-full min-w-0 rounded-control border border-line bg-surface px-3 py-1 text-body text-ink",
        "pointer-coarse:min-h-touch",
        "transition-[border-color,box-shadow] duration-fast",
        "placeholder:text-faint",
        "focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30",
        "aria-invalid:border-error aria-invalid:ring-2 aria-invalid:ring-error/25",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
