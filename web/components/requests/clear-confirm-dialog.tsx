"use client";

// Generic clear-data confirm (T11; prototype ScreenRequests.dc.html:295-309).
// Composed from the shared shadcn Base UI `AlertDialog` shell, but NOT from the
// shell `ConfirmDialog` (`@/components/shell/confirm-dialog.tsx`): that shell's
// `onOpenChange(false)` fires on BOTH cancel and confirm, which would collapse
// this component's separate `onConfirm`/`onCancel` callbacks into one signal.
//
// It is the app's one `layer="nested"` overlay — the shell's second named layer
// rather than an ad-hoc z-index. On the current live Requests route it is the
// only overlay mounted while it is open: the clear-data panel is a sibling of
// the cell/history/CSV dialogs, so none of them is mounted beneath it. `nested`
// is therefore a RESERVED higher layer here, held for a flow that raises a
// confirmation over a live dialog, not a concurrency this route performs.
//
// Dismissal safety: Cancel is the Base UI Close part and every other allowed
// dismissal also arrives as `onOpenChange(false)`, so an implicit dismissal can
// only ever reach `onCancel`. `onConfirm` has exactly one caller — the Clear
// button — and it is not a Close part, so it fires once and never on dismissal.

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
import { FaTriangleExclamation } from "@/components/icons";

export interface ClearConfirmDialogProps {
  open: boolean;
  text: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ClearConfirmDialog({ open, text, onConfirm, onCancel }: ClearConfirmDialogProps) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent
        layer="nested"
        data-testid="clear-confirm-dialog"
        className="overflow-hidden"
      >
        <AlertDialogHeader>
          <AlertDialogMedia tone="error">
            <FaTriangleExclamation />
          </AlertDialogMedia>
          <AlertDialogTitle>Confirm</AlertDialogTitle>
        </AlertDialogHeader>

        <AlertDialogBody>
          <AlertDialogDescription className="leading-relaxed">{text}</AlertDialogDescription>
        </AlertDialogBody>

        <AlertDialogFooter>
          <AlertDialogCancel data-testid="clear-confirm-cancel">Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            data-testid="clear-confirm-confirm"
            onClick={onConfirm}
          >
            Clear
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
