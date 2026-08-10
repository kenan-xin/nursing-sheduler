"use client";

// Roster document actions (F5) — the toolbar of export/import/clear actions plus
// the global Saving/saved/failed feedback.
//
// Per Core Flows "Where the actions live": destructive and export actions live on
// a roster-document menu, separate from the lens toggle's tap area. They wrap
// inside the roster content area (flex-wrap) so a future docked assistant
// narrowing the surface never creates page-level horizontal overflow, and they
// never disturb the Grid's internal scroller or sticky geometry.
//
// The save-status feedback is global (Core Flows: "a small global Saving state").
// On failure it offers Retry and keeps `Save roster file` available as rescue.
//
// `Save roster file` writes the portable `.nurse-roster.json` document and is the
// counterpart to Import: together they move a roster between devices and people,
// and they are what makes the viewer usable on its own without ever running an
// optimization. It is deliberately NOT the same idea as `Export XLSX`, which
// produces a spreadsheet for humans and cannot be read back in. It is also
// distinct from the browser autosave behind the Saving/Saved status, which keeps
// this device's copy durable but never leaves the browser — hence "Save… file"
// rather than the older "Export roster file", which read as a sibling of Export
// XLSX and buried the round-trip.
//
// G3: Import and Clear are extracted as standalone controls and re-composed into
// `EmptyRosterActions`, because both remain meaningful with no working roster —
// the file ingestion path and the shared-device privacy purge. The export/save
// half of this toolbar does not, and is not offered there.

import { useRef } from "react";
import {
  FaArrowRotateRight,
  FaDownload,
  FaFileArrowUp,
  FaFileCirclePlus,
  FaTrash,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { encodeRosterFile, type RosterDocument } from "@/lib/roster";
import type { AutosaveSnapshot } from "@/lib/roster";
import { patchFrozenXlsxWithEdits } from "@/lib/roster";
import { downloadBlob } from "@/lib/utils/download";

export interface RosterActionsProps {
  document: RosterDocument;
  /** The autosave status (Saving/saved/failed). */
  save: AutosaveSnapshot;
  /** Retry the last failed save. */
  onRetrySave: () => void;
  /** Import a roster file. The caller owns the discard-gate confirmation. */
  onImportFile: (file: File) => void;
  /** Clear roster & stored data. The caller owns the destructive confirmation. */
  onClear: () => void;
  /**
   * Surface a plain-language export failure. The patcher fails closed and the
   * roster stays visible; this reports WHY so the user knows the export did not
   * happen (and, for the failed-save rescue export, that the rescue copy was not
   * produced). Never swallowed.
   */
  onExportError: (message: string) => void;
}

export function RosterActions({
  document,
  save,
  onRetrySave,
  onImportFile,
  onClear,
  onExportError,
}: RosterActionsProps) {
  const onExportRosterFile = async () => {
    const result = await encodeRosterFile(document);
    if (result.ok) {
      downloadBlob(result.file.blob, result.file.filename);
    } else {
      // The roster-file codec fails closed; surface the reason rather than
      // silently looking like a successful click.
      onExportError("The roster file could not be exported. Try again.");
    }
  };

  const onExportXlsx = async () => {
    try {
      const blob = await patchFrozenXlsxWithEdits({
        frozenXlsx: document.frozenXlsx,
        edits: document.edits,
        coordinateMap: document.coordinateMap,
        provenance: document.provenance,
      });
      const firstDate = document.context.calendar[0]?.iso ?? "roster";
      downloadBlob(blob, `roster-${firstDate}-edited.xlsx`);
    } catch (error) {
      // The patcher fails closed (EditedXlsxError); the roster stays visible.
      // Surface a plain-language message — and especially do not swallow the
      // failed-save rescue export, which the user depends on to keep a copy.
      const reason =
        error instanceof Error && error.message.length > 0
          ? error.message
          : "the edited workbook could not be exported";
      onExportError(`The edited workbook could not be exported (${reason}). Try again.`);
    }
  };

  return (
    <div data-testid="roster-actions" className="flex flex-wrap items-center gap-2">
      {/* Save status feedback (global). */}
      <SaveStatus save={save} onRetry={onRetrySave} />

      <span className="flex-1" />

      {/* Export actions. */}
      <Button
        variant="ghost"
        size="sm"
        className="border border-line"
        onClick={() => void onExportRosterFile()}
        data-testid="roster-export-file"
      >
        <FaFileCirclePlus className="size-3.5" aria-hidden /> Save roster file
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="border border-line"
        onClick={() => void onExportXlsx()}
        data-testid="roster-export-xlsx"
      >
        <FaDownload className="size-3.5" aria-hidden /> Export XLSX
      </Button>

      {/* Import and Clear — the two controls the empty state shares. */}
      <RosterImportControl onImportFile={onImportFile} />
      <RosterClearControl onClear={onClear} />
    </div>
  );
}

/**
 * The Import trigger and its hidden file input.
 *
 * Extracted so the empty state and the loaded state mount the SAME control: one
 * accept list, one same-file-reselect reset, one label. The caller owns what
 * happens to the chosen file — decode, validation and the promotion fence all
 * live in `@/lib/roster`; this only produces a `File`.
 */
export function RosterImportControl({ onImportFile }: { onImportFile: (file: File) => void }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept=".nurse-roster.json,application/x-nurse-roster+json,application/json"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file !== undefined) onImportFile(file);
          // Reset so selecting the same file again still fires onChange.
          event.target.value = "";
        }}
      />
      <Button
        variant="ghost"
        size="sm"
        className="border border-line"
        onClick={() => fileInputRef.current?.click()}
        data-testid="roster-import"
      >
        <FaFileArrowUp className="size-3.5" aria-hidden /> Import roster file
      </Button>
    </>
  );
}

/**
 * Clear roster & stored data (destructive — the caller always confirms first).
 *
 * Shared by both states on purpose: the shared-device privacy contract makes this
 * control reachable whether or not a roster is currently on screen, and a second
 * copy of the button would be a second place for that promise to be dropped.
 */
export function RosterClearControl({ onClear }: { onClear: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="border border-line text-errorink"
      onClick={onClear}
      data-testid="roster-clear"
    >
      <FaTrash className="size-3.5" aria-hidden /> Clear roster &amp; stored data
    </Button>
  );
}

export interface EmptyRosterActionsProps {
  /** Import a roster file into an empty database. The caller owns the promotion. */
  onImportFile: (file: File) => void;
  /** Clear roster & stored data. The caller owns the destructive confirmation. */
  onClear: () => void;
}

/**
 * The document actions that mean something with NO working roster: the file
 * ingestion path, and the always-available privacy purge.
 *
 * Deliberately NOT `RosterActions` with things hidden. Save status, Save roster
 * file and Export XLSX all describe a roster that is on screen; offering them
 * here would advertise actions with no subject. What the empty state does owe the
 * user is the two controls that still have one: a roster file they were sent, and
 * whatever private data this browser is still holding.
 */
export function EmptyRosterActions({ onImportFile, onClear }: EmptyRosterActionsProps) {
  return (
    <div
      data-testid="roster-empty-actions"
      className="flex flex-wrap items-center justify-end gap-2"
    >
      <RosterImportControl onImportFile={onImportFile} />
      <RosterClearControl onClear={onClear} />
    </div>
  );
}

function SaveStatus({ save, onRetry }: { save: AutosaveSnapshot; onRetry: () => void }) {
  if (save.status === "saving") {
    return (
      <span
        className="inline-flex items-center gap-1.5 font-ui text-meta font-semibold text-ink2"
        data-testid="roster-save-saving"
      >
        <span className="size-1.5 animate-pulse rounded-[50%] bg-brand" aria-hidden /> Saving…
      </span>
    );
  }
  if (save.status === "saved") {
    return (
      <span
        className="inline-flex items-center gap-1.5 font-ui text-meta font-semibold text-successink"
        data-testid="roster-save-saved"
      >
        Saved
      </span>
    );
  }
  if (save.status === "failed" && save.failure !== null) {
    return (
      <div
        className={cn(
          "flex flex-wrap items-center gap-2 border border-error bg-errortint px-3 py-1.5",
        )}
        data-testid="roster-save-failed"
        role="alert"
      >
        <span className="font-ui text-meta font-semibold text-errorink">
          {save.failure.message}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="border border-error text-errorink"
          onClick={onRetry}
          data-testid="roster-save-retry"
        >
          <FaArrowRotateRight className="size-3.5" aria-hidden /> Retry save
        </Button>
      </div>
    );
  }
  return null;
}
