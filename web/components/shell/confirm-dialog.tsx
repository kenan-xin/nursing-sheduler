"use client";

// Shell-layer confirm dialog (T08, MINOR 10). Composed from the shared shadcn
// Base UI `AlertDialog` shell (F3) rather than from the primitive directly, so
// the portal, `bg-scrim` backdrop, raised L2 card, focus containment and focus
// restoration are the same ones every overlay in the app gets.
//
// The prototype's three-band composition (Nurse Scheduling.dc.html:200-221) is
// preserved through the shell's own header / body / footer slots: a severity
// tile plus title, an explanatory body with an OPTIONAL structured consequence
// list (for delete/cascade confirmations), and a bordered action band.
// Non-destructive confirms use the brand-tinted tile. One component serves every
// confirm need (New-schedule / Start over, dirty-nav guard, global
// delete-confirm, and the Save/Load version confirmation that wraps it).

import * as React from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="confirm-dialog" className="overflow-hidden">
        {/* Band 1 — severity tile + title */}
        <AlertDialogHeader>
          <AlertDialogMedia tone={destructive ? "error" : "brand"}>
            <FaTriangleExclamation />
          </AlertDialogMedia>
          <AlertDialogTitle>{title}</AlertDialogTitle>
        </AlertDialogHeader>

        {/* Band 2 — body + optional consequence list */}
        <AlertDialogBody>
          <AlertDialogDescription>{description}</AlertDialogDescription>
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
        </AlertDialogBody>

        {/* Band 3 — actions.
            Cancel is the Base UI Close part, so dismissing emits exactly ONE
            `onOpenChange(false)` and never reaches `onConfirm`. Confirm is a
            plain action button (not a Close), so the domain callback fires once
            and the single close signal is the explicit one below. Escape and an
            alert dialog's non-dismissable backdrop can therefore never confirm. */}
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="confirm-dialog-cancel">{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? "destructive" : "default"}
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
            data-testid="confirm-dialog-confirm"
          >
            {destructive && <FaTrash />}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
