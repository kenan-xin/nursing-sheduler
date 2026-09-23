"use client";

import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { surfaceVariants } from "@/components/ui/surface";
import { FaXmark } from "@/components/icons";

// Shared Base UI Dialog shell, added from the official shadcn `base-nova` source
// and adapted to the v2 contract. F2 publishes the shell; F3 owns migrating the
// eight overlay owners onto it.
//
// What is kept from the preset: the Base UI part structure and its `render`
// composition (no Radix `asChild`, no wrapper-only trigger DOM), the
// `data-slot` names, and the open/closed animation hooks driven by Base UI's own
// `data-open` / `data-closed` attributes.
//
// What is adapted:
//   • the backdrop is `bg-scrim` — the theme-specific scrim token. The preset's
//     raw translucent-black backdrop, and any fixed near-black RGBA overlay, are
//     off-contract (DESIGN.md §5 Navigation);
//   • the popup is the shared `raised` surface role (L2 `--surface2` + `--line`
//     + `--sh-3`) on the 16px card radius, taken from `surfaceVariants` rather
//     than restated here;
//   • the footer band is a `--panel` well that clips to the card's bottom corners;
//   • the close affordance is the app `Button` with a react-icons glyph from the
//     `@/components/icons` barrel — the preset's `lucide-react` import is not used.
//
// The explicit `data-[open]:` / `data-[closed]:` attribute-selector form is used
// in preference to the shorthand: Base UI publishes these as bare boolean
// attributes, and the explicit form cannot silently match nothing.

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

/**
 * The two stacking layers an overlay may occupy. `base` is every ordinary
 * overlay; `nested` is the deliberate second layer for a confirmation raised
 * FROM an already-open dialog. Owners select a layer by name so the app has
 * exactly two overlay z-values instead of a drift of ad-hoc ones.
 */
type DialogLayer = "base" | "nested";

function DialogOverlay({
  className,
  layer = "base",
  ...props
}: DialogPrimitive.Backdrop.Props & { layer?: DialogLayer }) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      data-layer={layer}
      className={cn(
        layer === "nested" ? "z-60" : "z-50",
        "fixed inset-0 isolate bg-scrim duration-fast",
        "data-[open]:animate-in data-[open]:fade-in-0 data-[closed]:animate-out data-[closed]:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  variant = "center",
  layer = "base",
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean;
  /**
   * `center` is the raised card every modal uses. `side` is the single
   * left-anchored drawer geometry (mobile navigation): the sidebar plane, the
   * directional `--sh-side` cast, square by contract, and a slide rather than a
   * fade. It is a shell variant rather than a forked component so the drawer
   * keeps the same portal, scrim, focus trap and scroll lock as every dialog.
   */
  variant?: "center" | "side";
  layer?: DialogLayer;
}) {
  return (
    <DialogPortal>
      <DialogOverlay layer={layer} />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        data-variant={variant}
        data-layer={layer}
        className={cn(
          layer === "nested" ? "z-60" : "z-50",
          // Motion, geometry AND width belong to the recipe, not to this call
          // site: a surface consumer's className is layout-only and admits no
          // arbitrary value. Type size is inherited from `body`, so the popup
          // states no size of its own.
          variant === "side"
            ? cn(
                "fixed inset-y-0 left-0 flex flex-col",
                surfaceVariants({
                  role: "drawer",
                  geometry: "square",
                  motion: "side",
                  width: "side",
                }),
              )
            : cn(
                "fixed left-1/2 top-1/2 grid -translate-x-1/2 -translate-y-1/2 gap-4 p-5",
                surfaceVariants({
                  role: "raised",
                  geometry: "card",
                  motion: "overlay",
                  width: "overlay",
                }),
              ),
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={<Button variant="ghost" size="icon" className="absolute right-2 top-2" />}
          >
            <FaXmark aria-hidden />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="dialog-header" className={cn("flex flex-col gap-2", className)} {...props} />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & { showCloseButton?: boolean }) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "-mx-5 -mb-5 flex flex-col-reverse gap-2 rounded-b-card border-t border-line2 p-5",
        "bg-panel sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>Close</DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "font-heading text-cardhead font-semibold leading-none tracking-[-0.015em]",
        className,
      )}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-meta text-ink2", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
