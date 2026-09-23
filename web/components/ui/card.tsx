import * as React from "react";
import { cn } from "@/lib/utils";
import { surfaceVariants } from "@/components/ui/surface";

// L1 card composed from the shared surface recipe (v2 technical plan T5): the
// `surface` role carries `--surface` + a `--line` hairline + `--sh-1`, and the
// card geometry carries the 16px role radius. Composition and every `data-slot`
// are unchanged from v1, so existing call sites and their tests keep working.
export function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "flex flex-col gap-4",
        surfaceVariants({ role: "surface", geometry: "card" }),
        className,
      )}
      {...props}
    />
  );
}

// A card that is the current selection swaps the hairline for a `--brand` border
// and lifts to `--sh-2` (DESIGN.md §4). Exposed as a prop rather than a second
// component so a list can drive it from state without branching its JSX.
export function SelectedCard({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      data-selected="true"
      className={cn(
        "flex flex-col gap-4",
        surfaceVariants({ role: "selected", geometry: "card" }),
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn("flex flex-col gap-1 px-5 pt-5", className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("font-heading text-cardhead font-semibold tracking-[-0.015em]", className)}
      {...props}
    />
  );
}

export function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="card-description" className={cn("text-meta text-ink2", className)} {...props} />
  );
}

export function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("px-5", className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center gap-2 px-5 pb-5", className)}
      {...props}
    />
  );
}
