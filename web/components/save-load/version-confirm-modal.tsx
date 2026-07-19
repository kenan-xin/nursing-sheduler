"use client";

// Combined load-confirmation modal (T17b-2 / T17r review P0; FR-SL-19/20;
// prototype ScreenSaveLoad.dc.html:141-158). Thin wrapper over the shared shell
// `ConfirmDialog` (read-only reuse — do not fork it). The wording is built by the
// pure, unit-tested `loadConfirmCopy` in `load-controls-core` (replacement +/or
// the exact FR-SL-19 version text), so this component only renders the already
// combined `title`/`description`. Cancel is a plain `onOpenChange(false)` — no
// `onConfirm` runs, so the caller's staged import is simply discarded (no-op,
// current state intact); Continue runs `onContinue` then closes.

import { ConfirmDialog } from "@/components/shell/confirm-dialog";

export interface VersionConfirmModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-built combined replacement/version dialog title (`loadConfirmCopy`). */
  title: string;
  /** Pre-built combined replacement/version dialog body (`loadConfirmCopy`). */
  description: string;
  onContinue: () => void;
}

export function VersionConfirmModal({
  open,
  onOpenChange,
  title,
  description,
  onContinue,
}: VersionConfirmModalProps) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      confirmLabel="Continue"
      cancelLabel="Cancel"
      onConfirm={onContinue}
    />
  );
}
