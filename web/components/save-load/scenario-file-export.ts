// Scenario-file Download/Copy decision core (T17a-4). Both actions route through
// the single validated export gate (`prepareExport`, T17a-2); an invalid draft
// blocks structurally and never reaches the injected write. DOM/clipboard side
// effects are injected rather than called directly here, so this module is
// pure and unit-testable without a browser environment — the component wires
// the real `Blob`/anchor/`navigator.clipboard` calls (e2e-covered).
//
// The two functions' dependency shapes are the enforcement mechanism for the
// ticket's backup-freshness decision: `PerformDownloadDeps` requires
// `recordBackup`, `PerformCopyDeps` has no such field, so Copy structurally
// cannot record a Workspace backup — there is no wiring mistake to make.

import {
  prepareWorkspaceExport,
  type PrepareExportResult,
  type ScenarioUiState,
} from "@/lib/scenario";

/** The filename stamped on every plain (non-anonymised) scenario download. */
export const SCENARIO_DOWNLOAD_FILENAME = "scenario.yaml";

export interface PerformDownloadDeps {
  /** Write the validated YAML to a file download. Never called on an invalid draft. */
  writeFile: (yaml: string, filename: string) => void;
  /** Record the emitted Workspace backup (`recordBackup`). Called ONLY after a successful write. */
  recordBackup: () => void;
}

export interface PerformCopyDeps {
  /** Write the validated YAML to the clipboard. Never called on an invalid draft. */
  writeClipboard: (yaml: string) => void;
}

/**
 * Download: validate via `prepareExport`, write the file, then record the backup.
 * An invalid draft writes nothing and never touches `recordBackup` (FR-SL-02b).
 */
export function performDownload(
  state: ScenarioUiState,
  deps: PerformDownloadDeps,
): PrepareExportResult {
  const result = prepareWorkspaceExport(state);
  if (!result.ok) return result;
  deps.writeFile(result.yaml, SCENARIO_DOWNLOAD_FILENAME);
  deps.recordBackup();
  return result;
}

/**
 * Copy: validate via `prepareExport`, write the clipboard. Deliberately has no
 * `recordBackup` dependency to call — Copy produces no durable backup artifact and
 * must not mark a backup current (ticket decision: backup freshness is defined
 * against the last plain Download, not against clipboard writes).
 */
export function performCopy(state: ScenarioUiState, deps: PerformCopyDeps): PrepareExportResult {
  const result = prepareWorkspaceExport(state);
  if (!result.ok) return result;
  deps.writeClipboard(result.yaml);
  return result;
}
