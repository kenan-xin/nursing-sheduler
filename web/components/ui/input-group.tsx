"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Shared field-with-addons shell, added from the official shadcn `base-nova`
// `input-group` source and adapted to the v2 contract. It exists because the
// official `combobox` source composes it; nothing else in the app needs a
// standalone input group yet, so only the parts the Combobox actually renders
// are kept — an unused `InputGroupText`/`InputGroupTextarea` here would be the
// dead export the ticket forbids.
//
// Deliberate deviations from the preset source:
//   • it reaches for the app's OWN `Button` and `Input`, which carry the v2
//     pill/control geometry, the coarse-pointer floor and the reinforced
//     focus-visible outline. The preset's own copies of those two files are NOT
//     adopted — overwriting them would replace the app's public variant and size
//     vocabulary that every call site depends on;
//   • `--radius-md`/`--radius` arithmetic is replaced by v2's radius ROLES: the
//     group is a control (12px), inner affordances are pills;
//   • `border-input` / `bg-input/30` / `ring-ring/50` become the canonical
//     `--line` / `--surface` / `--brand` tokens, so there is no second colour
//     layer and no hardcoded alpha on a semantic fill.

function InputGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-group"
      role="group"
      className={cn(
        "group/input-group relative flex h-control w-full min-w-0 items-center",
        "rounded-control border border-line bg-surface transition-[border-color,box-shadow] duration-fast",
        "pointer-coarse:min-h-touch",
        "has-[[data-slot=input-group-control]:focus-visible]:border-brand",
        "has-[[data-slot=input-group-control]:focus-visible]:ring-2",
        "has-[[data-slot=input-group-control]:focus-visible]:ring-brand/30",
        "has-disabled:opacity-50",
        "has-[>[data-align=inline-end]]:[&>input]:pr-1.5",
        "has-[>[data-align=inline-start]]:[&>input]:pl-1.5",
        className,
      )}
      {...props}
    />
  );
}

const inputGroupAddonVariants = cva(
  [
    "flex h-auto cursor-text items-center justify-center gap-2 py-1.5",
    "text-meta font-medium text-ink3 select-none",
    "[&>svg]:pointer-events-none [&>svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      align: {
        "inline-start": "order-first pl-2 has-[>button]:ml-[-0.3rem]",
        "inline-end": "order-last pr-2 has-[>button]:mr-[-0.3rem]",
      },
    },
    defaultVariants: { align: "inline-start" },
  },
);

function InputGroupAddon({
  className,
  align = "inline-start",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof inputGroupAddonVariants>) {
  return (
    <div
      role="group"
      data-slot="input-group-addon"
      data-align={align}
      className={cn(inputGroupAddonVariants({ align }), className)}
      onClick={(event) => {
        // Clicking the addon focuses the field — unless the click landed on a
        // real control inside it, which owns its own activation.
        if ((event.target as HTMLElement).closest("button") !== null) return;
        event.currentTarget.parentElement?.querySelector("input")?.focus();
      }}
      {...props}
    />
  );
}

function InputGroupButton({
  className,
  variant = "ghost",
  ...props
}: React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant={variant}
      size="sm"
      className={cn("size-control-sm border-0 p-0 shadow-none hover:shadow-none", className)}
      {...props}
    />
  );
}

function InputGroupInput({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <Input
      data-slot="input-group-control"
      className={cn(
        "h-auto flex-1 rounded-none border-0 bg-transparent",
        "focus-visible:border-0 focus-visible:ring-0",
        className,
      )}
      {...props}
    />
  );
}

export { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput };
