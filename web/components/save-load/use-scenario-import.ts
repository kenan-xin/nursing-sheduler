"use client";

// Shared inbound scenario-import pipeline (T17b-3; T17r review P0; qq0.23e). The
// single place that runs `prepareScenarioLoad` (T17b-1, pure) -> block on
// V-issues -> compute the shared uncredited-leave guard against the unchanged
// target and merge its named warnings with the base warnings BEFORE any load ->
// stage a combined replacement/version confirmation whenever the current
// workspace is non-empty OR the version is incompatible (direct commit only for a
// genuinely empty workspace on a matching version) -> commit via the store's
// `loadScenario` (one tracked undoable full-slice replacement, backup baseline
// null) and publish the pre-computed warnings. Both inbound entry points call
// `handleFile` and render the same confirm / `ImportWarningsBanner` from the
// state this hook returns -- the Upload modal and the Edit-YAML Apply, both wired
// in `save-load-workspace.tsx`.

import { useState } from "react";
import { toast } from "sonner";
import {
  classifyLoadVersion,
  currentAppVersion,
  findImportUncreditedLeaveFindings,
  formatUncreditedLeaveWarnings,
  prepareScenarioLoad,
  type ImportNormalizationTarget,
  type ScenarioValidationIssue,
  type VersionConfirmStatus,
} from "@/lib/scenario";
import { isScenarioSliceEmpty, loadScenario, useHotStore, useScenarioStore } from "@/lib/store";
import { loadConfirmCopy } from "./load-controls-core";

/** Ready-to-render props for the combined load confirmation dialog. */
export interface PendingImportConfirm {
  /** Combined replacement + version dialog title. */
  title: string;
  /** Combined replacement + version dialog body. */
  description: string;
  onContinue: () => void;
  onCancel: () => void;
}

export interface UseScenarioImportOptions {
  /** Runs after a successful `loadScenario` replace -- direct version match, or Continue on the version-confirm gate. */
  onCommitted?: () => void;
}

export interface UseScenarioImportResult {
  issues: ScenarioValidationIssue[] | null;
  clearIssues: () => void;
  clearImportState: () => void;
  confirm: PendingImportConfirm | null;
  warnings: string[] | null;
  dismissWarnings: () => void;
  handleFile: (text: string) => void;
}

interface StagedTarget {
  /** The FR-SL-19 version case, or `null` when the file version matches. */
  versionStatus: VersionConfirmStatus | null;
  /** Whether the current (pre-load) workspace is non-empty and would be overwritten. */
  replacement: boolean;
  fileVersion: string | undefined;
  target: ImportNormalizationTarget;
  /**
   * The final merged + deduped warning list — base advanced-syntax survivors plus
   * the uncredited-leave guard findings, computed from `target` BEFORE any
   * `loadScenario` call. Direct-version and confirmed-version paths publish this
   * same list; `commit` never re-runs guard resolution after mutation.
   */
  warnings: string[];
}

/**
 * Run the shared uncredited-leave detector against the unchanged, keyless import
 * target and merge its deterministic named warnings with the base advanced-syntax
 * warnings, deduplicating while preserving order (base first). Guard resolution is
 * fail-closed by design and must never interrupt or roll back an import; any
 * unexpected throw degrades to just the base warnings (tech-plan §5, "Import guard
 * cannot resolve → import still replaces state ... shows only the warnings that
 * were safely computed").
 */
function mergeImportWarnings(
  target: ImportNormalizationTarget,
  baseWarnings: readonly string[],
): string[] {
  let guardWarnings: string[] = [];
  try {
    const findings = findImportUncreditedLeaveFindings({
      staff: target.staff,
      staffGroups: target.staffGroups,
      shifts: target.shifts,
      shiftGroups: target.shiftGroups,
      rangeStart: target.rangeStart,
      rangeEnd: target.rangeEnd,
      dateGroups: target.dateGroups,
      reqData: target.reqData,
      counts: target.cardsByKind.counts,
    });
    guardWarnings = formatUncreditedLeaveWarnings(
      findings,
      target.staff,
      target.cardsByKind.counts,
    );
  } catch {
    guardWarnings = [];
  }

  const merged: string[] = [];
  const seen = new Set<string>();
  for (const warning of [...baseWarnings, ...guardWarnings]) {
    if (seen.has(warning)) continue;
    seen.add(warning);
    merged.push(warning);
  }
  return merged;
}

export function useScenarioImport(options: UseScenarioImportOptions = {}): UseScenarioImportResult {
  const { onCommitted } = options;
  const [issues, setIssues] = useState<ScenarioValidationIssue[] | null>(null);
  const [staged, setStaged] = useState<StagedTarget | null>(null);
  const [warnings, setWarnings] = useState<string[] | null>(null);

  // Commit performs EXACTLY ONE state replacement, then publishes the warning list
  // that was already computed from the unchanged target before this call. It never
  // runs guard resolution after mutation.
  const commit = (target: ImportNormalizationTarget, stagedWarnings: string[]) => {
    loadScenario(useScenarioStore, useHotStore, target);
    setWarnings(stagedWarnings.length > 0 ? stagedWarnings : null);
    setStaged(null);
    onCommitted?.();
    toast.success("Scenario loaded — this replaces your current setup.");
  };

  const handleFile = (text: string) => {
    const result = prepareScenarioLoad(text);
    if (result.issues.length > 0 || !result.target) {
      setIssues(result.issues);
      return;
    }
    setIssues(null);
    // Compute the full merged warning list from the unchanged target NOW, before
    // any `loadScenario` call. Both the direct and version-confirmed paths publish
    // this exact list, so the guard is evaluated once against the pre-load target.
    const mergedWarnings = mergeImportWarnings(result.target, result.warnings);
    const versionStatus = classifyLoadVersion(result.target.meta.appVersion);
    // Emptiness is computed against the CURRENT (pre-load) workspace at the moment
    // of load — the state the incoming file would overwrite.
    const replacement = !isScenarioSliceEmpty(useScenarioStore.getState());
    // DL12: only a genuinely empty workspace on a matching version commits
    // directly; every other load stages one combined confirmation.
    if (versionStatus === null && !replacement) {
      commit(result.target, mergedWarnings);
      return;
    }
    setStaged({
      versionStatus,
      replacement,
      fileVersion: result.target.meta.appVersion,
      target: result.target,
      warnings: mergedWarnings,
    });
  };

  const confirm: PendingImportConfirm | null = staged
    ? {
        ...loadConfirmCopy(
          staged.versionStatus,
          staged.replacement,
          staged.fileVersion,
          currentAppVersion(),
        ),
        onContinue: () => commit(staged.target, staged.warnings),
        onCancel: () => setStaged(null),
      }
    : null;

  return {
    issues,
    clearIssues: () => setIssues(null),
    clearImportState: () => {
      setIssues(null);
      setStaged(null);
      setWarnings(null);
    },
    confirm,
    warnings,
    dismissWarnings: () => setWarnings(null),
    handleFile,
  };
}
