"use client";

// Version-mismatch confirm modal (T17b-2; FR-SL-19/20; prototype
// ScreenSaveLoad.dc.html:141-158). Thin wrapper over the shared shell
// `ConfirmDialog` (read-only reuse — do not fork it): the wording comes from
// `versionMismatchCopy`, so the exact FR-SL-19 three-case text lives in one
// pure, unit-tested place. Cancel is a plain `onOpenChange(false)` — no
// `onConfirm` runs, so the caller's staged import is simply discarded (no-op,
// current state intact); Continue runs `onContinue` then closes.

import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { versionMismatchCopy, type VersionConfirmStatus } from "./load-controls-core";

export interface VersionConfirmModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: VersionConfirmStatus;
  fileVersion: string | undefined;
  currentVersion: string;
  onContinue: () => void;
}

export function VersionConfirmModal({
  open,
  onOpenChange,
  status,
  fileVersion,
  currentVersion,
  onContinue,
}: VersionConfirmModalProps) {
  const { title, description } = versionMismatchCopy(status, fileVersion, currentVersion);

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
