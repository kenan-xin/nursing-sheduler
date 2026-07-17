"use client";

// Shell-layer confirm dialog (T08, MINOR 10). Built on @base-ui/react AlertDialog
// (not native confirm()) and restyled to the prototype's three-band composition
// (Nurse Scheduling.dc.html:200-221): a warning-tile/title header, an explanatory
// body with an OPTIONAL structured consequence list (for delete/cascade
// confirmations), and a bordered action footer. Non-destructive confirms use the
// simpler body and a brand-tinted tile. One component serves every confirm need
// (New-schedule / Start over, dirty-nav guard, global delete-confirm).

import * as React from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { FaTriangleExclamation, FaTrash } from "@/components/icons";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "destructive";
  /** Structured cascade consequences shown as a bullet list under the description. */
  consequences?: string[];
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
  consequences,
  onConfirm,
}: ConfirmDialogProps) {
  const destructive = variant === "destructive";
  const hasConsequences = Boolean(consequences && consequences.length > 0);

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/40 animate-fade" />
        <AlertDialog.Popup
          data-slot="confirm-dialog"
          className="fixed left-1/2 top-1/2 z-50 flex w-full max-w-md -translate-x-1/2 -translate-y-1/2 flex-col border border-line bg-surface shadow-dialog animate-fade"
        >
          {/* Band 1 — icon tile + title */}
          <div className="flex items-center gap-3 border-b border-line2 px-5 py-4">
            <span
              className={cn(
                "flex size-9 shrink-0 items-center justify-center",
                destructive ? "bg-errortint text-error" : "bg-brandtint text-brandink",
              )}
            >
              <FaTriangleExclamation className="size-4" />
            </span>
            <AlertDialog.Title className="font-heading text-cardhead font-extrabold tracking-tight">
              {title}
            </AlertDialog.Title>
          </div>

          {/* Band 2 — body + optional consequence list */}
          <div className="flex flex-col gap-3 px-5 py-4">
            <AlertDialog.Description className="text-meta text-ink2">
              {description}
            </AlertDialog.Description>
            {hasConsequences && (
              <ul
                data-testid="confirm-dialog-consequences"
                className="flex list-disc flex-col gap-1.5 pl-5"
              >
                {consequences!.map((line) => (
                  <li key={line} className="text-meta text-ink">
                    {line}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Band 3 — actions */}
          <div className="flex items-center justify-end gap-2.5 border-t border-line2 px-5 py-3.5">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              data-testid="confirm-dialog-cancel"
            >
              {cancelLabel}
            </Button>
            <Button
              variant={destructive ? "destructive" : "default"}
              onClick={() => {
                onConfirm();
                onOpenChange(false);
              }}
              data-testid="confirm-dialog-confirm"
            >
              {destructive && <FaTrash />}
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
