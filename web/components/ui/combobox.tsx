"use client";

import * as React from "react";
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { cn } from "@/lib/utils";
import { FaCheck, FaChevronDown } from "@/components/icons";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";

// Searchable single-select, added from the official shadcn `base-nova`
// `combobox` source and adapted to the v2 contract.
//
// Base UI composition is intact: `Root` owns the value/filter/open state, the
// `Portal`/`Positioner`/`Popup` stack owns placement and the `--anchor-width` /
// `--available-height` custom properties, and `Item`/`ItemIndicator` keep the
// primitive's highlight, typeahead and keyboard contract. Nothing here re-implements
// list navigation or filtering.
//
// Deliberate deviations from the preset source:
//   • the preset's chips/multi-select, group, collection and separator parts are
//     NOT adopted. The one consumer is a single-select shift chooser, and an
//     unexported-but-present part would be the dead code this ticket forbids;
//   • icons come from the project's react-icons barrel, because `lucide-react`
//     imports are banned by the icon convention (components/icons.tsx);
//   • `bg-popover` / `ring-foreground/10` / `rounded-lg` become v2's canonical
//     `--surface2` L2 popup plane, a `--line` hairline, `--sh-3` and the card
//     radius role;
//   • the import is the `@base-ui/react/combobox` subpath, matching every other
//     primitive in this directory.

const Combobox = ComboboxPrimitive.Root;

function ComboboxTrigger({ className, children, ...props }: ComboboxPrimitive.Trigger.Props) {
  return (
    <ComboboxPrimitive.Trigger
      data-slot="combobox-trigger"
      className={cn("[&_svg:not([class*='size-'])]:size-3.5", className)}
      {...props}
    >
      {children}
      <FaChevronDown className="pointer-events-none size-3.5 text-ink3" aria-hidden />
    </ComboboxPrimitive.Trigger>
  );
}

function ComboboxInput({
  className,
  children,
  ...props
}: ComboboxPrimitive.Input.Props & { children?: React.ReactNode }) {
  return (
    <InputGroup className={cn("w-auto", className)}>
      <ComboboxPrimitive.Input render={<InputGroupInput />} {...props} />
      <InputGroupAddon align="inline-end">
        {/* The PRIMITIVE is the outer element and the app Button is what it
            renders. The preset nests these the other way round; inverting keeps
            Base UI's trigger behaviour on the element that owns the click rather
            than relying on two layers of `render` merging. */}
        <ComboboxTrigger
          render={<InputGroupButton />}
          aria-label="Show shifts"
          className="data-pressed:bg-transparent"
        />
      </InputGroupAddon>
      {children}
    </InputGroup>
  );
}

function ComboboxContent({
  className,
  side = "bottom",
  sideOffset = 6,
  align = "start",
  ...props
}: ComboboxPrimitive.Popup.Props &
  Pick<ComboboxPrimitive.Positioner.Props, "side" | "align" | "sideOffset">) {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        className="isolate z-50"
      >
        <ComboboxPrimitive.Popup
          data-slot="combobox-content"
          className={cn(
            "group/combobox-content relative max-h-(--available-height) max-w-(--available-width)",
            "min-w-[max(var(--anchor-width),16rem)] origin-(--transform-origin) overflow-hidden",
            "rounded-card border border-line bg-surface2 text-ink shadow-3",
            className,
          )}
          {...props}
        />
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
}

function ComboboxList({ className, ...props }: ComboboxPrimitive.List.Props) {
  return (
    <ComboboxPrimitive.List
      data-slot="combobox-list"
      className={cn(
        "max-h-[min(18rem,var(--available-height))] scroll-py-1 overflow-y-auto overscroll-contain p-1",
        className,
      )}
      {...props}
    />
  );
}

function ComboboxItem({ className, children, ...props }: ComboboxPrimitive.Item.Props) {
  return (
    <ComboboxPrimitive.Item
      data-slot="combobox-item"
      className={cn(
        "relative flex w-full cursor-default select-none items-center gap-2 rounded-control",
        "py-1.5 pl-2 pr-8 text-meta text-ink outline-none",
        "pointer-coarse:min-h-touch",
        "data-highlighted:bg-panel-alt data-disabled:pointer-events-none data-disabled:opacity-50",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      {...props}
    >
      {children}
      <ComboboxPrimitive.ItemIndicator
        render={
          <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center text-brandink" />
        }
      >
        <FaCheck className="size-3.5" aria-hidden />
      </ComboboxPrimitive.ItemIndicator>
    </ComboboxPrimitive.Item>
  );
}

function ComboboxEmpty({ className, ...props }: ComboboxPrimitive.Empty.Props) {
  return (
    <ComboboxPrimitive.Empty
      data-slot="combobox-empty"
      className={cn(
        "hidden w-full justify-center px-2 py-3 text-center text-meta text-ink3",
        "group-data-empty/combobox-content:flex",
        className,
      )}
      {...props}
    />
  );
}

export {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
};
