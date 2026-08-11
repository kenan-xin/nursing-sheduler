"use client";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { cn } from "@/lib/utils";

// Dropdown menu, added from the official shadcn `base-nova` `dropdown-menu`
// source and adapted to the v2 contract.
//
// Base UI composition is intact: `Root`/`Trigger`/`Portal`/`Positioner`/`Popup`
// own open state, placement, focus management, typeahead and the `data-*` state
// contract. Nothing here re-implements popup behaviour.
//
// Deliberate deviations from the preset source:
//   • the preset's submenu, checkbox-item, radio-group and shortcut parts are NOT
//     adopted. The one consumer is the narrow-layout `Roster file` menu, and an
//     unused part would be the dead export this ticket forbids;
//   • `bg-popover` / `ring-foreground/10` / `rounded-lg` become v2's canonical
//     `--surface2` L2 popup plane, a `--line` hairline, `--sh-3` and the card
//     radius role; the destructive item takes `--errorink` + `--errortint`
//     rather than an alpha-composited `destructive/10`;
//   • items meet the coarse-pointer 44px floor on the control itself, like every
//     other real control in the system.

function DropdownMenu({ ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuContent({
  align = "end",
  side = "bottom",
  sideOffset = 6,
  className,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<MenuPrimitive.Positioner.Props, "align" | "side" | "sideOffset">) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        className="isolate z-50 outline-none"
        align={align}
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(
            "max-h-(--available-height) min-w-56 origin-(--transform-origin)",
            "overflow-y-auto overflow-x-hidden rounded-card border border-line bg-surface2 p-1",
            "text-ink shadow-3 outline-none",
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function DropdownMenuItem({
  className,
  variant = "default",
  ...props
}: MenuPrimitive.Item.Props & { variant?: "default" | "destructive" }) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-variant={variant}
      className={cn(
        "relative flex cursor-default select-none items-center gap-2 rounded-control",
        "px-2 py-2 text-meta font-medium text-ink outline-none",
        "pointer-coarse:min-h-touch",
        "data-highlighted:bg-panel-alt",
        "data-[variant=destructive]:text-errorink data-[variant=destructive]:data-highlighted:bg-errortint",
        "data-disabled:pointer-events-none data-disabled:opacity-50",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-line", className)}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
};
