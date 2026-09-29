"use client";

// Shared inbound scenario-import pipeline (T17b-3; T17r review P0; qq0.23e). The
// single place that runs `prepareScenarioLoad` (T17b-1, pure) -> block on
// V-issues -> compute the shared uncredited-leave guard against the unchanged
// target and merge its named warnings with the base warnings BEFORE any load ->
// stage a combined replacement/version confirmation whenever the current
// workspace is non-empty OR the version is incompatible (direct commit only for a
// genuinely empty workspace on a matching version) -> commit via the store's
// `loadScenario` (a switch to a fresh identity, not undoable, backup baseline
// null) and publish the pre-computed warnings. The Upload modal calls `handleFile`;
// the Edit-YAML Apply calls `handleEdit`, which commits one undoable edit on the
// same identity instead of a Load (C-06). Both render the same confirm /
// `ImportWarningsBanner` from the state this hook returns, wired in
// `save-load-workspace.tsx`.

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
import {
  hasBlockingUnsupportedExpression,
  UNSUPPORTED_EXPRESSION_REASON,
} from "@/lib/optimize/optimize-readiness";
import {
  applyScenarioEdit,
  isScenarioSliceEmpty,
  loadScenario,
  useScenarioStore,
} from "@/lib/store";
import { loadConfirmCopy, v1LeaveShiftOfferCopy } from "./load-controls-core";

/** Ready-to-render props for the combined load confirmation dialog. */
export interface PendingImportConfirm {
  /** Combined replacement + version dialog title. */
  title: string;
  /** Combined replacement + version dialog body. */
  description: string;
  /** FR-SL-19 file/current version pair for the mono detail box, when the version case applies. */
  detail?: string;
  /** Destructive style: the load overwrites a non-empty workspace and cannot be undone. */
  destructive?: boolean;
  /** Button labels when not the default Continue / Cancel. */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Resolves only after the load has committed or been refused -- hold the confirm busy until then. */
  onContinue: () => Promise<void>;
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
  /**
   * Apply an Edit-YAML draft as ONE undoable edit on the current scenario identity
   * (v1 parity, C-06): same validation, warnings and version gate as `handleFile`,
   * but no replacement confirm and no identity switch, so Undo history and the
   * assistant thread survive.
   */
  handleEdit: (text: string) => void;
}

interface StagedTarget {
  /** The FR-SL-19 version case, or `null` when the file version matches. */
  versionStatus: VersionConfirmStatus | null;
  /** Whether the current (pre-load) workspace is non-empty and would be overwritten. */
  replacement: boolean;
  fileVersion: string | undefined;
  target: ImportNormalizationTarget;
  /** An Edit-YAML apply (undoable edit) rather than a Load (identity switch). */
  edit: boolean;
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
  // wa46: an unsupported count expression still loads; say now that Optimize will
  // stay blocked until it is edited, in the same words the Optimize screen uses.
  const expressionWarnings = hasBlockingUnsupportedExpression(target.cardsByKind.counts)
    ? [UNSUPPORTED_EXPRESSION_REASON]
    : [];
  for (const warning of [...baseWarnings, ...guardWarnings, ...expressionWarnings]) {
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
  // The offer to convert a v1 "Leave" shift (objg), shown before any load confirm.
  const [leaveOffer, setLeaveOffer] = useState<PendingImportConfirm | null>(null);

  // Commit performs EXACTLY ONE state replacement, then publishes the warning list
  // that was already computed from the unchanged target before this call. It never
  // runs guard resolution after mutation.
  const commit = async (
    target: ImportNormalizationTarget,
    stagedWarnings: string[],
    edit: boolean,
  ) => {
    if (edit) {
      // An Edit-YAML apply is an ordinary tracked edit on THIS identity (C-06).
      const outcome = await applyScenarioEdit(target);
      if (!outcome.ok) {
        toast.error(
          outcome.reason === "not-owner"
            ? "This schedule is being edited in another tab. Take over editing, then apply again."
            : "Could not apply your changes — nothing was changed.",
        );
        return;
      }
      setWarnings(stagedWarnings.length > 0 ? stagedWarnings : null);
      setStaged(null);
      onCommitted?.();
      toast.success("Changes applied. Undo reverts them.");
      return;
    }
    // A Load is an atomic scenario SWITCH: it mints a fresh identity holding the
    // imported content, so the restored file cannot inherit the previous document's
    // history or receipts.
    //
    // AWAITED, and BRANCHED ON. Fire-and-forget cleared the staged file and reported
    // "Scenario loaded" before the switch had settled — so a refused switch (this tab
    // is read-only, or was taken over mid-dialog) destroyed the user's staged upload
    // and told them it had worked. On refusal nothing is changed and the error toast
    // says so; the confirm then closes (its close discards the staging), so a retry
    // means choosing the file again after taking editing back.
    //
    // The returned promise is what the confirm dialog holds its busy state on: it must
    // not settle before the IndexedDB switch has committed, or a hard reload in that
    // window aborts the write and silently drops the import (nursing-sheduler-iks).
    const outcome = await loadScenario(target);
    if (!outcome.ok) {
      toast.error(
        outcome.reason === "not-owner"
          ? "This schedule is being edited in another tab. Take over editing, then load again."
          : "Could not load the scenario — nothing was changed.",
      );
      return;
    }
    setWarnings(stagedWarnings.length > 0 ? stagedWarnings : null);
    setStaged(null);
    onCommitted?.();
    toast.success("Scenario loaded — this replaces your current setup.");
  };

  const stage = (text: string, edit: boolean, convertV1LeaveShift = false) => {
    const result = prepareScenarioLoad(text, { convertV1LeaveShift });
    const plan = result.v1LeaveShift;
    if (plan && !convertV1LeaveShift && plan.convertible) {
      // The dialog closes through `onCancel` after Continue too, so only a real
      // decline may publish the rename error.
      let accepted = false;
      setIssues(null);
      setLeaveOffer({
        ...v1LeaveShiftOfferCopy(plan),
        confirmLabel: "Convert to paid leave",
        cancelLabel: "Don't convert",
        onContinue: async () => {
          accepted = true;
          setLeaveOffer(null);
          stage(text, edit, true);
        },
        onCancel: () => {
          setLeaveOffer(null);
          if (!accepted) setIssues(result.issues);
        },
      });
      return;
    }
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
    // of load — the state the incoming file would overwrite. An edit is undoable,
    // so it overwrites nothing that cannot come back.
    const replacement = !edit && !isScenarioSliceEmpty(useScenarioStore.getState());
    // DL12: only a genuinely empty workspace on a matching version commits
    // directly; every other load stages one combined confirmation.
    if (versionStatus === null && !replacement) {
      void commit(result.target, mergedWarnings, edit);
      return;
    }
    setStaged({
      versionStatus,
      replacement,
      fileVersion: result.target.meta.appVersion,
      target: result.target,
      edit,
      warnings: mergedWarnings,
    });
  };

  const confirm: PendingImportConfirm | null = leaveOffer
    ? leaveOffer
    : staged
      ? {
          ...loadConfirmCopy(
            staged.versionStatus,
            staged.replacement,
            staged.fileVersion,
            currentAppVersion(),
          ),
          onContinue: () => commit(staged.target, staged.warnings, staged.edit),
          onCancel: () => setStaged(null),
        }
      : null;

  return {
    issues,
    clearIssues: () => setIssues(null),
    clearImportState: () => {
      setIssues(null);
      setStaged(null);
      setLeaveOffer(null);
      setWarnings(null);
    },
    confirm,
    warnings,
    dismissWarnings: () => setWarnings(null),
    handleFile: (text) => stage(text, false),
    handleEdit: (text) => stage(text, true),
  };
}
