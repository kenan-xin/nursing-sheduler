"use client";

import * as React from "react";
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// The app Button, merged onto the official shadcn Base variant (v2 technical
// plan T6.5). It wraps `@base-ui/react/button`, so `render` and `nativeButton`
// composition and Base UI's `data-*` state contract are intact — there is no
// Radix `asChild` and no wrapper-only trigger DOM. What is NOT adopted from the
// preset is its styling and its size vocabulary: the app's public variant names
// (default / secondary / outline / ghost / destructive / destructive-outline /
// link), its sizes (sm / default / lg / icon) and its `type="button"` default
// are the contract every call site already depends on.
//
// v2 visual contract (DESIGN.md §5 Buttons, §4 rule 4):
//   • pill shape on every variant;
//   • filled variants take `--sh-1` and flatten on `:active`;
//   • secondary, ghost AND outline are all L1 (`--surface` + a hairline +
//     `--sh-1`), never transparent — a transparent button on the recessed page
//     does not read as pressable. DESIGN.md §4 rule 4 and §5 name "Secondary /
//     Ghost" together, so the two share one treatment and differ only as public
//     names that let a call site express intent; `outline` is the distinct
//     heavier-edged variant on `--rule`;
//   • absolute control heights (32 / 36 / 44 / 36-square) that the 0.9 density
//     baseline cannot shrink, and a real 44x44 minimum on coarse pointers — set
//     on the control itself, never a pseudo-element hitbox;
//   • focus-visible is a 2px `--brand` outline at -1px offset, reinforcing the
//     global rule in globals.css rather than replacing it with a ring.
//
// `destructive-outline` exists because the v2 destructive affordance is an
// OUTLINE in every place the system uses it (ScreenSaveLoad's "New schedule",
// the group delete control) while `destructive` stays the paired solid fill.
// Without it those call sites had to hand-override the variant's colours, which
// is exactly the caller-owned visual override this component must not require.
const buttonVariants = cva(
  [
    "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-pill font-medium",
    "transition-[background-color,box-shadow,color,filter] duration-fast",
    "focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-brand",
    "disabled:pointer-events-none disabled:opacity-50",
    "pointer-coarse:min-h-touch pointer-coarse:min-w-touch",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        default: "bg-brand text-onbrand shadow-1 hover:brightness-[0.94] active:shadow-none",
        secondary:
          "border border-line bg-surface text-ink shadow-1 hover:bg-panel-alt hover:shadow-2 active:shadow-none",
        outline:
          "border border-rule bg-surface text-ink shadow-1 hover:bg-panel-alt hover:shadow-2 active:shadow-none",
        // Canonical L1, exactly like `secondary` (DESIGN.md §4 rule 4 and §5
        // name "Secondary / Ghost" together): a transparent button on the
        // recessed page does not read as pressable. The two stay separate PUBLIC
        // names because call sites express intent with them, but v2 gives them
        // one treatment; `outline` is the distinct heavier-edged variant.
        ghost:
          "border border-line bg-surface text-ink shadow-1 hover:bg-panel-alt hover:shadow-2 active:shadow-none",
        destructive:
          "bg-fill-error text-on-error shadow-1 hover:brightness-[0.94] active:shadow-none",
        "destructive-outline":
          "border border-error bg-surface text-errorink shadow-1 hover:bg-errortint hover:shadow-2 active:shadow-none",
        link: "text-brandink underline-offset-4 hover:underline",
      },
      size: {
        sm: "h-control-sm px-3 text-meta [&_svg]:size-3.5",
        default: "h-control px-4 text-body [&_svg]:size-4",
        lg: "h-control-lg px-6 text-body [&_svg]:size-4",
        icon: "size-control [&_svg]:size-4",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

// Base UI's own props already carry `ref`, `render`, `nativeButton` and the
// native <button> attribute surface; only `className` is narrowed, from Base UI's
// string-or-state-callback form to a plain string, because this component composes
// it through `cn()`.
export interface ButtonProps
  extends Omit<ButtonPrimitive.Props, "className">, VariantProps<typeof buttonVariants> {
  /** Layout only. Colour, elevation, radius and state live in the variants. */
  className?: string;
}

export function Button({ className, variant, size, nativeButton, type, ...props }: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      nativeButton={nativeButton}
      // A native <button> defaults to type="submit"; every button in this app is
      // an action unless a caller opts in. When `nativeButton={false}` the
      // rendered element is not a button, so `type` is left alone rather than
      // stamped onto an element it means nothing on.
      type={nativeButton === false ? type : (type ?? "button")}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { buttonVariants };
