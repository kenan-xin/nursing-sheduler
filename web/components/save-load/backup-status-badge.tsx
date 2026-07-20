"use client";

// Workspace-backup freshness indicator (T08e). Surfaces the tri-state
// `selectBackupStatus` — No backup / Backup current / Backup out of date — on the
// Save & Load surface, distinct from the browser auto-save `PersistenceBadge`:
//
//   • PersistenceBadge answers "is my work saved in THIS browser?" (T04 autosave,
//     lives in the YAML preview header).
//   • BackupStatusBadge answers "does my last downloaded backup file still match
//     my current work?" (updated only by a successful plain Download).
//
// It is a DISPLAY-ONLY affordance: it never gates navigation, unload, or any
// operation (DL12/T17r review P0) — it merely re-renders as the workspace and its
// recorded backup diverge. Like `PersistenceBadge` it is deliberately NOT a live
// region: announcing "Backup out of date" on every keystroke would flood assistive
// tech, so it is static explanatory copy that happens to re-render on change.

import { selectBackupStatus, useScenarioStore, type BackupStatus } from "@/lib/store";
import { cn } from "@/lib/utils";
import { FaFloppyDisk, FaCircleCheck, FaTriangleExclamation } from "@/components/icons";

const LABEL: Record<BackupStatus, string> = {
  none: "No backup",
  current: "Backup current",
  stale: "Backup out of date",
};

function toneClass(status: BackupStatus): string {
  if (status === "stale") return "text-warn";
  if (status === "current") return "text-success";
  return "text-ink3";
}

function StatusMark({ status }: { status: BackupStatus }) {
  if (status === "stale") {
    return <FaTriangleExclamation className="size-3 text-warn" aria-hidden />;
  }
  if (status === "current") {
    return <FaCircleCheck className="size-3 text-success" aria-hidden />;
  }
  return <FaFloppyDisk className="size-3 text-ink3" aria-hidden />;
}

/**
 * Tri-state backup-freshness badge for the Scenario-file card header. Subscribes
 * to the durable store through `selectBackupStatus`, which recomputes the Workspace
 * V1 fingerprint each render — so Guided pins, disabled/incomplete records and
 * export layout all count toward "out of date", and a strict-projection edit can
 * never be misreported as current.
 */
export function BackupStatusBadge() {
  const status = useScenarioStore(selectBackupStatus);
  return (
    <span
      data-testid="backup-status"
      data-status={status}
      className={cn(
        "inline-flex items-center gap-2 border border-line bg-surface px-3 py-1.5 text-label uppercase tracking-[0.03em]",
        toneClass(status),
      )}
    >
      <StatusMark status={status} />
      {LABEL[status]}
    </span>
  );
}
