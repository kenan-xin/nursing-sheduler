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
//
// R7 v2: the hand-rolled span is replaced by the shared `Badge`, which pairs each
// tint with its MATCHING semantic ink AND a border in the base hue — v1 painted a
// neutral `--surface` chip and carried state in the text colour alone, which the
// Redundant Signal Rule (DESIGN.md §2) forbids. The leading status glyphs are gone
// with it: §5 retires decorative ornament on status ("no check glyphs"), so the
// label carries the state and the badge's text content is unchanged.

import { selectBackupStatus, useScenarioStore, type BackupStatus } from "@/lib/store";
import { Badge, type BadgeProps } from "@/components/ui/badge";

const LABEL: Record<BackupStatus, string> = {
  none: "No backup",
  current: "Backup current",
  stale: "Backup out of date",
};

/**
 * The semantic tier each state reads at. `stale` is the only actionable one, so it
 * takes `warn`; `current` is a settled good state on the quieter success tier; and
 * `none` is genuinely neutral — nothing has gone wrong before a first Download.
 */
const VARIANT: Record<BackupStatus, NonNullable<BadgeProps["variant"]>> = {
  none: "neutral",
  current: "success",
  stale: "warn",
};

/**
 * Tri-state backup-freshness badge for the Scenario-file card header. Subscribes
 * to the durable store through `selectBackupStatus`, which recomputes the Workspace
 * V1 fingerprint each render — so disabled/incomplete records and export layout all
 * count toward "out of date", and a strict-projection edit can never be
 * misreported as current.
 */
export function BackupStatusBadge() {
  const status = useScenarioStore(selectBackupStatus);
  return (
    <Badge data-testid="backup-status" data-status={status} variant={VARIANT[status]}>
      {LABEL[status]}
    </Badge>
  );
}
