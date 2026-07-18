"use client";

// Generic clear-data confirm (T11; prototype ScreenRequests.dc.html:295-309).
// Built directly on base-ui AlertDialog rather than wrapping the shell
// `ConfirmDialog` (`@/components/shell/confirm-dialog.tsx`): that shell's
// `onOpenChange(false)` fires on BOTH cancel and confirm, which would collapse
// this component's separate `onConfirm`/`onCancel` callbacks into one signal.
// Styling mirrors the shell dialog's three-band composition for visual parity.

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Button } from "@/components/ui/button";
import { FaTriangleExclamation } from "@/components/icons";

export interface ClearConfirmDialogProps {
  open: boolean;
  text: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ClearConfirmDialog({ open, text, onConfirm, onCancel }: ClearConfirmDialogProps) {
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-[62] bg-black/40 animate-fade" />
        <AlertDialog.Popup
          data-testid="clear-confirm-dialog"
          className="fixed left-1/2 top-1/2 z-[63] flex w-[420px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col border border-line bg-surface shadow-dialog animate-fade"
        >
          <div className="flex items-center gap-3 border-b border-line2 px-5 py-4.5">
            <span className="flex size-8.5 shrink-0 items-center justify-center bg-errortint text-error">
              <FaTriangleExclamation className="size-4" />
            </span>
            <AlertDialog.Title className="font-heading text-cardhead font-extrabold tracking-tight">
              Confirm
            </AlertDialog.Title>
          </div>

          <AlertDialog.Description className="px-5 py-4.5 text-meta leading-relaxed text-ink2">
            {text}
          </AlertDialog.Description>

          <div className="flex items-center justify-end gap-2.5 border-t border-line2 px-5 py-3.5">
            <Button variant="outline" data-testid="clear-confirm-cancel" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="destructive" data-testid="clear-confirm-confirm" onClick={onConfirm}>
              Clear
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
