"use client";

import * as React from "react";
import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { surfaceVariants } from "@/components/ui/surface";

// Shared Base UI ToggleGroup shell, added from the official shadcn `base-nova`
// source and adapted to the v2 contract. F2 publishes the shell; its consumers
// (the four-option accent control, mode/segmented controls) are their own
// tickets' to migrate.
//
// Deliberate deviations from the preset source:
//   • the preset splits `toggleVariants` into a separate `toggle.tsx` file. This
//     ticket owns `toggle-group.tsx` only, so the item recipe lives here and is
//     exported as `toggleGroupItemVariants`. There is no standalone `Toggle`
//     consumer in the app to justify the extra file.
//   • the preset's `spacing`/rounding gymnastics (`rounded-[min(var(--radius-md),
//     12px)]`, per-edge radius stripping) are dropped: they key off a generic
//     `--radius-md` step that v2 pins to 0 as the square fallback. v2 rounds by
//     ROLE — the group is a `well` pill and its items are pills inside it.
//   • selection is `--brandtint` + `--brandink` (the system's selection
//     language), never the generic hover/zebra `accent` tone.
//
// Base UI composition is intact: `render`, the generic `Value` type parameter,
// roving-focus/keyboard behaviour, and the `data-pressed` / `data-disabled` state
// contract all come from the primitive.

const toggleGroupItemVariants = cva(
  [
    "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-pill",
    "font-semibold transition-[background-color,box-shadow,color] duration-fast",
    "focus-visible:z-10 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-brand",
    "disabled:pointer-events-none disabled:opacity-50",
    "pointer-coarse:min-h-touch pointer-coarse:min-w-touch",
    "data-[pressed]:bg-brandtint data-[pressed]:text-brandink",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        default: "text-ink2 hover:bg-panel-alt hover:text-ink",
        outline: "border border-line bg-surface text-ink2 hover:bg-panel-alt hover:text-ink",
      },
      size: {
        sm: "h-control-sm px-3 text-label [&_svg]:size-3.5",
        default: "h-control px-4 text-meta [&_svg]:size-4",
        lg: "h-control-lg px-5 text-body [&_svg]:size-4",
        // Square item whose whole content is a colour chip (the accent control).
        // It is a REAL 32px control that grows to 44px on a coarse pointer via
        // the shared base classes, not a 24px swatch with a hit area painted on.
        swatch: "size-control-sm p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type ToggleGroupVariantProps = VariantProps<typeof toggleGroupItemVariants>;

const ToggleGroupContext = React.createContext<ToggleGroupVariantProps>({
  variant: "default",
  size: "default",
});

export type ToggleGroupProps<Value extends string = string> = Omit<
  ToggleGroupPrimitive.Props<Value>,
  "className"
> &
  ToggleGroupVariantProps & {
    className?: string;
    /** Render the group as an inset segmented well (the prototype's tablist). */
    segmented?: boolean;
  };

function ToggleGroup<Value extends string = string>({
  className,
  variant,
  size,
  segmented = false,
  children,
  ...props
}: ToggleGroupProps<Value>) {
  const context = React.useMemo(() => ({ variant, size }), [variant, size]);
  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      data-variant={variant ?? "default"}
      data-size={size ?? "default"}
      data-segmented={segmented ? "true" : undefined}
      className={cn(
        "flex w-fit flex-row items-center gap-1 data-[orientation=vertical]:flex-col",
        "data-[orientation=vertical]:items-stretch",
        segmented && "p-1",
        segmented && surfaceVariants({ role: "well", geometry: "pill" }),
        className,
      )}
      {...props}
    >
      <ToggleGroupContext.Provider value={context}>{children}</ToggleGroupContext.Provider>
    </ToggleGroupPrimitive>
  );
}

export type ToggleGroupItemProps<Value extends string = string> = Omit<
  TogglePrimitive.Props<Value>,
  "className"
> &
  ToggleGroupVariantProps & { className?: string };

function ToggleGroupItem<Value extends string = string>({
  className,
  variant,
  size,
  children,
  ...props
}: ToggleGroupItemProps<Value>) {
  const context = React.useContext(ToggleGroupContext);
  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      className={cn(
        toggleGroupItemVariants({
          variant: variant ?? context.variant,
          size: size ?? context.size,
        }),
        className,
      )}
      {...props}
    >
      {children}
    </TogglePrimitive>
  );
}

export { ToggleGroup, ToggleGroupItem, toggleGroupItemVariants };
