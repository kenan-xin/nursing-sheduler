import * as React from "react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";

// Shimmer-from-structure skeletons. The primitive is a panel-filled box that
// pulses via the `animate-shimmer` token (opacity pulse; suppressed under
// prefers-reduced-motion by the global rule in globals.css). "From structure"
// means callers size each skeleton to the layout box it stands in for, rather
// than dropping in a generic spinner — the helpers below (SkeletonLine,
// SkeletonText, SkeletonCard) reproduce the target's structure so the loading
// box matches the resolved box in both width AND height.

export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("animate-shimmer rounded-none bg-panel", className)}
      {...props}
    />
  );
}

// One shimmer bar occupying exactly one line box of the surrounding text size.
// Put the matching `text-*` size class on it; `h-[1lh]` resolves to that size's
// line box (line-height is inherited as 1.5), so the bar reproduces the height
// of the text line it replaces — not just its width.
export function SkeletonLine({ className, ...props }: React.ComponentProps<"div">) {
  return <Skeleton className={cn("h-[1lh]", className)} {...props} />;
}

export function SkeletonText({
  lines = 3,
  className,
  ...props
}: React.ComponentProps<"div"> & { lines?: number }) {
  return (
    <div data-slot="skeleton-text" className={cn("flex flex-col gap-2", className)} {...props}>
      {Array.from({ length: lines }).map((_, i) => (
        <SkeletonLine key={i} className={cn("text-body", i === lines - 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}

// Structural twin of a resolved <Card>: it reuses the same Card / header /
// content / footer primitives (identical padding + gaps) and mirrors the same
// row structure — one title line, one description line, two body lines, and a
// small action button — with each row sized to one line box of its text size.
// So the loading box matches the resolved box in BOTH width and height. The
// style page renders a resolved card with exactly this structure alongside it.
export function SkeletonCard({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <Card data-slot="skeleton-card" aria-hidden className={className} {...props}>
      <CardHeader>
        <SkeletonLine className="text-cardhead w-1/2" />
        <SkeletonLine className="text-meta w-3/4" />
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <SkeletonLine className="text-body w-full" />
        <SkeletonLine className="text-body w-2/3" />
      </CardContent>
      <CardFooter>
        <Skeleton className="h-8 w-24" />
      </CardFooter>
    </Card>
  );
}
