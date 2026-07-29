"use client";

import * as React from "react";
import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { surfaceVariants } from "@/components/ui/surface";

// Shared Base UI AlertDialog shell, added from the official shadcn `base-nova`
// source and adapted to the v2 contract. F2 publishes the shell; F3 owns
// migrating the overlay owners (including `shell/confirm-dialog.tsx`) onto it.
//
// Same adaptation as `dialog.tsx`: `bg-scrim` instead of a raw translucent black,
// the shared `raised` surface role on the card radius instead of restated
// tone/ring/radius classes, a `--panel` action band clipped to the bottom
// corners, and the app `Button` for the action/cancel pair. Base UI's `render`
// composition and `data-*` state contract are untouched.
//
// The preset's `AlertDialogMedia` slot is kept: the app's confirm composition is
// an icon tile plus title, and the tile is a semantic (not decorative) severity
// signal.

function AlertDialog({ ...props }: AlertDialogPrimitive.Root.Props) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

function AlertDialogTrigger({ ...props }: AlertDialogPrimitive.Trigger.Props) {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

function AlertDialogPortal({ ...props }: AlertDialogPrimitive.Portal.Props) {
  return <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />;
}

/** The same two named stacking layers the Dialog shell publishes. */
type AlertDialogLayer = "base" | "nested";

function AlertDialogOverlay({
  className,
  layer = "base",
  ...props
}: AlertDialogPrimitive.Backdrop.Props & { layer?: AlertDialogLayer }) {
  return (
    <AlertDialogPrimitive.Backdrop
      data-slot="alert-dialog-overlay"
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

function AlertDialogContent({
  className,
  layer = "base",
  ...props
}: AlertDialogPrimitive.Popup.Props & { layer?: AlertDialogLayer }) {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay layer={layer} />
      <AlertDialogPrimitive.Popup
        data-slot="alert-dialog-content"
        data-layer={layer}
        className={cn(
          layer === "nested" ? "z-60" : "z-50",
          "fixed left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col",
          // Motion and the overlay width live in the recipe (see dialog.tsx);
          // type size is inherited.
          surfaceVariants({
            role: "raised",
            geometry: "card",
            motion: "overlay",
            width: "overlay",
          }),
          className,
        )}
        {...props}
      />
    </AlertDialogPortal>
  );
}

function AlertDialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn("flex items-center gap-3 border-b border-line2 px-5 py-4", className)}
      {...props}
    />
  );
}

function AlertDialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-body"
      className={cn("flex flex-col gap-3 px-5 py-4", className)}
      {...props}
    />
  );
}

function AlertDialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2.5 rounded-b-card border-t border-line2 bg-panel px-5 py-3.5",
        "sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

/** Severity tile. `tone` selects the semantic tint/ink pair; never a raw colour. */
function AlertDialogMedia({
  className,
  tone = "brand",
  ...props
}: React.ComponentProps<"div"> & { tone?: "brand" | "warn" | "error" }) {
  return (
    <div
      data-slot="alert-dialog-media"
      data-tone={tone}
      className={cn(
        "inline-flex size-control shrink-0 items-center justify-center rounded-control",
        tone === "error" && "bg-errortint text-errorink",
        tone === "warn" && "bg-warntint text-warnink",
        tone === "brand" && "bg-brandtint text-brandink",
        "[&_svg]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogTitle({ className, ...props }: AlertDialogPrimitive.Title.Props) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn("font-heading text-cardhead font-semibold tracking-[-0.015em]", className)}
      {...props}
    />
  );
}

function AlertDialogDescription({ className, ...props }: AlertDialogPrimitive.Description.Props) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn("whitespace-pre-line text-meta text-ink2", className)}
      {...props}
    />
  );
}

function AlertDialogAction({ className, ...props }: React.ComponentProps<typeof Button>) {
  return <Button data-slot="alert-dialog-action" className={cn(className)} {...props} />;
}

function AlertDialogCancel({
  className,
  variant = "outline",
  size = "default",
  ...props
}: AlertDialogPrimitive.Close.Props &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <AlertDialogPrimitive.Close
      data-slot="alert-dialog-cancel"
      className={cn(className)}
      render={<Button variant={variant} size={size} />}
      {...props}
    />
  );
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
};
