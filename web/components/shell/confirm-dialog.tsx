"use client";

// Shell-layer confirm dialog (T08). Built on @base-ui/react AlertDialog (not
// native confirm()) restyled to the design tokens — square corners, shadow-dialog,
// token palette only. One component serves every confirm need: New-schedule
// reset, dirty-nav guard, and the global delete-confirm modal. Controlled via
// `open` + `onOpenChange` so callers can imperatively drive it.

import * as React from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "destructive";
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "default",
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/40 animate-fade" />
        <AlertDialog.Popup
          data-slot="confirm-dialog"
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex w-full max-w-md -translate-x-1/2 -translate-y-1/2 flex-col gap-4 border border-line bg-surface p-6 shadow-dialog animate-fade",
          )}
        >
          <AlertDialog.Title className="font-heading text-h3 font-semibold tracking-tight">
            {title}
          </AlertDialog.Title>
          <AlertDialog.Description className="text-body text-ink2">
            {description}
          </AlertDialog.Description>
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => onOpenChange(false)}
              data-testid="confirm-dialog-cancel"
            >
              {cancelLabel}
            </Button>
            <Button
              variant={variant === "destructive" ? "destructive" : "default"}
              onClick={() => {
                onConfirm();
                onOpenChange(false);
              }}
              data-testid="confirm-dialog-confirm"
            >
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
