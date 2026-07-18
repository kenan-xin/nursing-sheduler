"use client";

// Shift Requests toolbar (T11, prototype ScreenRequests.dc.html:24-38): the mode
// tabs (Edit cells / Quick paint) plus the CSV/clear-data action row. Purely
// presentational — the container owns `mode`/`clearOpen` state and CSV/clear
// wiring.

import { cn } from "@/lib/utils";
import { FaFileArrowUp } from "@/components/icons";
// Not re-exported from the icon barrel (icons.tsx is owned by a concurrently
// edited ticket) — imported directly per the project's react-icons/fa6
// convention (see upload-modal.tsx).
import { FaArrowPointer, FaBrush, FaClockRotateLeft, FaEraser } from "react-icons/fa6";

export interface RequestsToolbarProps {
  mode: "normal" | "quick";
  onSetMode: (m: "normal" | "quick") => void;
  onOpenRequestsCsv: () => void;
  onOpenHistoryCsv: () => void;
  clearOpen: boolean;
  onToggleClear: () => void;
  /** FR-SR-34: within Quick Add mode, Requests CSV also needs a valid weight. */
  requestsCsvDisabled?: boolean;
  /** Shown as the button's `title` (tooltip) while `requestsCsvDisabled`. */
  requestsCsvDisabledReason?: string;
}

export function RequestsToolbar({
  mode,
  onSetMode,
  onOpenRequestsCsv,
  onOpenHistoryCsv,
  clearOpen,
  onToggleClear,
  requestsCsvDisabled = false,
  requestsCsvDisabledReason,
}: RequestsToolbarProps) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3" data-testid="requests-toolbar">
      <div role="tablist" className="inline-flex border border-line">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "normal"}
          data-testid="requests-tab-normal"
          onClick={() => onSetMode("normal")}
          className={cn(
            "inline-flex h-10 items-center gap-1.5 px-3.5 text-meta font-semibold",
            mode === "normal" ? "bg-brand text-onbrand" : "bg-transparent text-ink2 hover:bg-panel",
          )}
        >
          <FaArrowPointer className="size-3" />
          Edit cells
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "quick"}
          data-testid="requests-tab-quick"
          onClick={() => onSetMode("quick")}
          className={cn(
            "inline-flex h-10 items-center gap-1.5 px-3.5 text-meta font-semibold",
            mode === "quick" ? "bg-brand text-onbrand" : "bg-transparent text-ink2 hover:bg-panel",
          )}
        >
          <FaBrush className="size-3" />
          Quick paint
        </button>
      </div>

      {mode === "quick" && (
        <div className="inline-flex items-center gap-2 text-meta text-ink3">
          <FaBrush className="size-3" />
          Configure your preset below, then drag across the grid.
        </div>
      )}

      {/* FR-SR-34: BOTH CSV upload controls exist only in Quick Add mode — a
          Normal-mode upload would bypass the quick-paint-only import rule. */}
      {mode === "quick" && (
        <>
          <button
            type="button"
            disabled={requestsCsvDisabled}
            aria-disabled={requestsCsvDisabled}
            title={requestsCsvDisabled ? requestsCsvDisabledReason : undefined}
            data-testid="requests-open-requests-csv"
            onClick={onOpenRequestsCsv}
            className={cn(
              "inline-flex h-10 items-center gap-2 border border-line bg-transparent px-3.5 text-meta font-semibold",
              requestsCsvDisabled ? "cursor-not-allowed opacity-50" : "hover:bg-panel",
            )}
          >
            <FaFileArrowUp className="size-3.5" />
            Requests CSV
          </button>
          <button
            type="button"
            data-testid="requests-open-history-csv"
            onClick={onOpenHistoryCsv}
            className="inline-flex h-10 items-center gap-2 border border-line bg-transparent px-3.5 text-meta font-semibold hover:bg-panel"
          >
            <FaClockRotateLeft className="size-3.5" />
            History CSV
          </button>
        </>
      )}
      <button
        type="button"
        aria-pressed={clearOpen}
        data-testid="requests-toggle-clear"
        onClick={onToggleClear}
        className="inline-flex h-10 items-center gap-2 border border-line bg-transparent px-3.5 text-meta font-semibold text-error hover:bg-errortint"
      >
        <FaEraser className="size-3.5" />
        Clear data
      </button>
    </div>
  );
}
