"use client";

// Shared inbound scenario-import pipeline (T17b-3). The single place that
// runs `prepareScenarioLoad` (T17b-1, pure) -> block on V-issues, or gate on
// `classifyImportVersion` -> commit via the store's `loadScenario` (paused
// replace, fresh baseline, history cleared) -> uncredited-LEAVE fence. Both
// inbound entry points call `handleFile` and render the same
// `VersionConfirmModal` / `ImportWarningsBanner` from the state this hook
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
import { loadScenario, useHotStore, useScenarioStore } from "@/lib/store";
import {
  hasUncreditedLeave,
  UNCREDITED_LEAVE_WARNING,
  type VersionConfirmStatus,
} from "./load-controls-core";

/** Ready-to-render props for `VersionConfirmModal` (minus `open`, which the caller controls). */
export interface PendingImportConfirm {
  status: VersionConfirmStatus;
  fileVersion: string | undefined;
  currentVersion: string;
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
  status: VersionConfirmStatus;
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
    if (status === "match") {
      commit(result.target, result.warnings);
      return;
    }
    setStaged({
      status,
      fileVersion: result.target.meta.appVersion,
      target: result.target,
      warnings: result.warnings,
    });
  };

  const confirm: PendingImportConfirm | null = staged
    ? {
        status: staged.status,
        fileVersion: staged.fileVersion,
        currentVersion: currentAppVersion(),
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
