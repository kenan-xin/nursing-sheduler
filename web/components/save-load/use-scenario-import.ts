"use client";

// Shared inbound scenario-import pipeline (T17b-3; T17r review P0). The single
// place that runs `prepareScenarioLoad` (T17b-1, pure) -> block on V-issues ->
// stage a combined replacement/version confirmation whenever the current
// workspace is non-empty OR the version is incompatible (direct commit only for a
// genuinely empty workspace on a matching version) -> commit via the store's
// `loadScenario` (one tracked undoable full-slice replacement, backup baseline
// null) -> uncredited-LEAVE fence. Both inbound entry points call `handleFile`
// and render the same confirm / `ImportWarningsBanner` from the state this hook
// returns -- the Upload modal and the Edit-YAML Apply, both wired in
// `save-load-workspace.tsx`.

import { useState } from "react";
import { toast } from "sonner";
import {
  classifyImportVersion,
  currentAppVersion,
  prepareScenarioLoad,
  type ImportNormalizationTarget,
  type ScenarioValidationIssue,
} from "@/lib/scenario";
import { isScenarioSliceEmpty, loadScenario, useHotStore, useScenarioStore } from "@/lib/store";
import {
  hasUncreditedLeave,
  loadConfirmCopy,
  UNCREDITED_LEAVE_WARNING,
  type VersionConfirmStatus,
} from "./load-controls-core";

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
  warnings: string[];
}

export function useScenarioImport(options: UseScenarioImportOptions = {}): UseScenarioImportResult {
  const { onCommitted } = options;
  const [issues, setIssues] = useState<ScenarioValidationIssue[] | null>(null);
  const [staged, setStaged] = useState<StagedTarget | null>(null);
  const [warnings, setWarnings] = useState<string[] | null>(null);

  const commit = (target: ImportNormalizationTarget, baseWarnings: string[]) => {
    loadScenario(useScenarioStore, useHotStore, target);
    const fenced = hasUncreditedLeave(target)
      ? [...baseWarnings, UNCREDITED_LEAVE_WARNING]
      : baseWarnings;
    setWarnings(fenced.length > 0 ? fenced : null);
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
    const status = classifyImportVersion(result.target.meta.appVersion);
    const versionStatus: VersionConfirmStatus | null = status === "match" ? null : status;
    // Emptiness is computed against the CURRENT (pre-load) workspace at the moment
    // of load — the state the incoming file would overwrite.
    const replacement = !isScenarioSliceEmpty(useScenarioStore.getState());
    // DL12: only a genuinely empty workspace on a matching version commits
    // directly; every other load stages one combined confirmation.
    if (versionStatus === null && !replacement) {
      commit(result.target, result.warnings);
      return;
    }
    setStaged({
      versionStatus,
      replacement,
      fileVersion: result.target.meta.appVersion,
      target: result.target,
      warnings: result.warnings,
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
