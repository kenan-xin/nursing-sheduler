"use client";

// The one "Replace the roster on screen?" confirmation, shared by candidate Load
// (roster section) and file Import (working-roster panel). Replacing drops the
// viewed roster's hand edits, so when it has any the dialog counts them, turns
// destructive, and offers to save the roster file first (audit C-07).

import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { encodeRosterFile, type RosterDocument } from "@/lib/roster";
import { downloadBlob } from "@/lib/utils/download";

export interface ReplaceRosterDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What replaces the roster, e.g. "...by the imported file." */
  description: string;
  /** The roster being viewed, with its current edits. */
  viewed: RosterDocument | null;
  onConfirm: () => void;
  /** Report a failed "Save roster file first". */
  onSaveError: (message: string) => void;
}

export function ReplaceRosterDialog({
  open,
  onOpenChange,
  description,
  viewed,
  onConfirm,
  onSaveError,
}: ReplaceRosterDialogProps) {
  const editCount = viewed?.edits.length ?? 0;
  const saveFirst = async () => {
    if (viewed === null) return;
    const result = await encodeRosterFile(viewed);
    if (result.ok) downloadBlob(result.file.blob, result.file.filename);
    else onSaveError("The roster file could not be saved. Try again.");
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Replace the roster on screen?"
      description={
        editCount === 0
          ? description
          : `${description} ${editCount} manual ${editCount === 1 ? "edit" : "edits"} will be lost.`
      }
      confirmLabel="Replace roster"
      variant={editCount === 0 ? "default" : "destructive"}
      secondaryAction={
        editCount === 0
          ? undefined
          : { label: "Save roster file first", onClick: () => void saveFirst() }
      }
      onConfirm={onConfirm}
    />
  );
}
