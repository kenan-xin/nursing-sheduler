import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// Status badges keyed to the semantic tokens (brand / success / warn / error),
// each using its tint fill so weights read at a glance. Square corners.
const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-none border px-2 py-0.5 text-label font-semibold uppercase tracking-[0.03em] [&_svg]:size-3",
  {
    variants: {
      variant: {
        neutral: "border-line bg-panel text-ink2",
        brand: "border-transparent bg-brandtint text-brandink",
        // Status badges (review #3): text is `ink` (≥13:1 on the tint in both
        // themes) and the status hue is carried redundantly by the border (and
        // the caller's icon), so meaning never depends on color-contrast alone.
        success: "border-success bg-successtint text-ink",
        warn: "border-warn bg-warntint text-ink",
        error: "border-error bg-errortint text-ink",
        outline: "border-line bg-transparent text-ink2",
      },
    },
    defaultVariants: {
      variant: "neutral",
    },
  },
);

export interface BadgeProps
  extends React.ComponentProps<"span">, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { badgeVariants };
