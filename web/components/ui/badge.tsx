import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// Status badge on the v2 chip geometry (9px) with the semantic tiers paired the
// way DESIGN.md §5 requires: each tint sits with its MATCHING semantic ink and a
// border in the base hue. Every pair clears WCAG AA in both themes (the tightest
// is light `--warnink` on `--warntint` at 4.88:1), and the border carries the hue
// redundantly, so state never rests on colour contrast alone.
//
// DESIGN.md also retires decorative ornament on status: no check glyphs and no
// coloured leader dots. Text and the semantic pair carry the state. A caller may
// still pass a genuinely informative glyph (the locked auto-group's padlock),
// which is an affordance rather than ornament.
const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-chip border px-2 py-0.5 text-label font-semibold [&_svg]:size-3",
  {
    variants: {
      variant: {
        neutral: "border-line bg-panel text-ink2",
        brand: "border-brand bg-brandtint text-brandink",
        success: "border-success bg-successtint text-successink",
        warn: "border-warn bg-warntint text-warnink",
        error: "border-error bg-errortint text-errorink",
        outline: "border-line bg-transparent text-ink2",
      },
      // Status labels are uppercase eyebrows at +0.03em. Authored data (a person
      // or shift-type name rendered as a chip) is `normal` — it must read exactly
      // as the user typed it, so this is a variant rather than something every
      // call site re-specifies through `className`.
      casing: {
        upper: "uppercase tracking-[0.03em]",
        normal: "normal-case tracking-normal",
      },
    },
    defaultVariants: {
      variant: "neutral",
      casing: "upper",
    },
  },
);

export interface BadgeProps
  extends React.ComponentProps<"span">, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, casing, ...props }: BadgeProps) {
  return (
    <span
      data-slot="badge"
      data-variant={variant ?? "neutral"}
      className={cn(badgeVariants({ variant, casing }), className)}
      {...props}
    />
  );
}

export { badgeVariants };
