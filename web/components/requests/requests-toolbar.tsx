"use client";

// Shift Requests toolbar (T11, prototype ScreenRequests.dc.html:24-38): the mode
// tabs (Edit cells / Quick paint) plus the CSV/clear-data action row. Purely
// presentational — the container owns `mode`/`clearOpen` state and CSV/clear
// wiring.
//
// v2 re-skin: the three action controls are the shared `Button` (secondary /
// destructive-outline), which carries the pill shape, the L1 --surface fill +
// --sh-1 that DESIGN.md §4 rule 4 requires of a secondary control (a transparent
// outline on the recessed page does not read as pressable), and the real 44×44
// coarse-pointer floor. The mode tabs stay a `role="tablist"` segmented control:
// they are not standalone buttons, and they mirror the F3-owned Cell Preference
// tablist (bordered track, square segments) for consistency within the route.

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
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
      {/* Square bordered track with square segments, matching the F3-owned Cell
          Preference tablist; segments reach the 44px coarse minimum on touch. */}
      <div role="tablist" className="inline-flex rounded-none border border-line">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "normal"}
          data-testid="requests-tab-normal"
          onClick={() => onSetMode("normal")}
          className={cn(
            "pointer-coarse:min-h-touch inline-flex h-control items-center gap-1.5 px-3.5 text-meta font-semibold",
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
            "pointer-coarse:min-h-touch inline-flex h-control items-center gap-1.5 px-3.5 text-meta font-semibold",
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
          <Button
            variant="secondary"
            size="sm"
            disabled={requestsCsvDisabled}
            title={requestsCsvDisabled ? requestsCsvDisabledReason : undefined}
            data-testid="requests-open-requests-csv"
            onClick={onOpenRequestsCsv}
          >
            <FaFileArrowUp />
            Requests CSV
          </Button>
          <Button
            variant="secondary"
            size="sm"
            data-testid="requests-open-history-csv"
            onClick={onOpenHistoryCsv}
          >
            <FaClockRotateLeft />
            History CSV
          </Button>
        </>
      )}
      <Button
        variant="destructive-outline"
        size="sm"
        aria-pressed={clearOpen}
        data-testid="requests-toggle-clear"
        onClick={onToggleClear}
      >
        <FaEraser />
        Clear data
      </Button>
    </div>
  );
}
