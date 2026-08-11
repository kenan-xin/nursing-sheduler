"use client";

// Roster viewer shell (F4) — the read-only roster experience.
//
// Composes the three lenses (Grid / Coverage / Day), the provenance banner, the
// lens toggle, and the container-width observer. The caller supplies a
// `RosterDocument` (the working roster) and receives a fully self-contained
// read-only viewer. Editing, import/export, and Clear are F5's — nothing here
// mutates the document.
//
// The settled non-technical surface (F2 decision): the primary submit action is
// always "Optimize"; no Forget, Abandon, Optimize-again, snapshot/storage/
// backend-job terminology, or extra recovery action. Candidate Load/Retry/
// Dismiss are roster-result actions and live on the calling screen, not here.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FaCalendarDay,
  FaLayerGroup,
  FaRotateLeft,
  FaTableCells,
  type IconType,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import {
  deriveCurrentDays,
  deriveEditedSinceSolve,
  type EditCoordinate,
  type RosterDayState,
  type RosterDocument,
} from "@/lib/roster";
import {
  assignShiftRamp,
  buildAssignmentIndex,
  buildProvenanceView,
  computeCoverage,
  computeRequirementGrid,
  computeTallies,
  deriveRequirementModel,
  readViewPreference,
  resolveFocusedDay,
  summariseRequirements,
  writeViewPreference,
} from "@/lib/roster-viewer";
import { RosterGrid } from "./roster-grid";
import { RosterCoverage } from "./roster-coverage";
import { RosterDay } from "./roster-day";
import { RosterEditBar } from "./roster-edit-bar";
import { useRosterContentWidth } from "./roster-content-width";
import { MOBILE_DEFAULT_LENS_VIEWPORT } from "./use-container-width";

export type RosterLens = "grid" | "coverage" | "day";

/**
 * The editing surface the viewer consumes when editing is enabled (F5). This is a
 * subset of the editing hook's return — only what the viewer needs to render the
 * edit bar, selection, drag-swap, and undo. Export/import/clear live on the
 * calling section, which holds the full hook.
 */
export interface RosterViewerEditing {
  selectedCell: EditCoordinate | null;
  selectCell: (coordinate: EditCoordinate | null) => void;
  setCell: (coordinate: EditCoordinate, day: RosterDayState) => void;
  swapCells: (a: EditCoordinate, b: EditCoordinate) => void;
  undo: () => void;
  canUndo: boolean;
}

export interface RosterViewerProps {
  document: RosterDocument;
  /** When present, the Grid lens becomes editable. */
  editing?: RosterViewerEditing;
}

function defaultLens(): RosterLens {
  if (typeof window !== "undefined" && window.innerWidth < MOBILE_DEFAULT_LENS_VIEWPORT) {
    return "day";
  }
  return "grid";
}

export function RosterViewer({ document, editing }: RosterViewerProps) {
  // The persisted preference is read ONCE, during the initial state, so a later
  // write from this same viewer cannot feed back in as an "external" change.
  const restored = useState(() => readViewPreference())[0];
  const [lens, setLens] = useState<RosterLens>(() => restored?.lens ?? defaultLens());
  const [focusedDay, setFocusedDay] = useState(() =>
    resolveFocusedDay(document.context.calendar, restored),
  );
  const width = useRosterContentWidth();

  const currentDays = useMemo(
    () => deriveCurrentDays(document.solvedDays, document.edits),
    [document.solvedDays, document.edits],
  );
  const ramp = useMemo(
    () => assignShiftRamp(document.context.shiftTypes),
    [document.context.shiftTypes],
  );
  // The ephemeral staffing-equation projection. Keyed on the IMMUTABLE
  // submission, so it survives every edit without being recomputed, and nothing
  // about it is ever written back into the persisted document.
  const model = useMemo(() => deriveRequirementModel(document.submission), [document.submission]);
  const assignments = useMemo(
    () => buildAssignmentIndex(document.context, currentDays),
    [document.context, currentDays],
  );
  const coverage = useMemo(
    () => computeCoverage(document.context, assignments, model),
    [document.context, assignments, model],
  );
  const requirements = useMemo(
    () => computeRequirementGrid(model, assignments, document.context.calendar.length),
    [model, assignments, document.context.calendar.length],
  );
  const tallies = useMemo(
    () => computeTallies(document.context, currentDays),
    [document.context, currentDays],
  );
  const provenance = useMemo(
    () => buildProvenanceView(document.provenance, deriveEditedSinceSolve(document.edits)),
    [document.provenance, document.edits],
  );
  // The roster-level claim comes from DECLARED equation health, never from how
  // many exact lanes happened to carry a cached baseline.
  const summary = useMemo(() => summariseRequirements(requirements), [requirements]);

  const calendar = document.context.calendar;

  // IN-PLACE ROSTER REPLACEMENT.
  //
  // React preserves state for the same component at the same tree position, so
  // loading a different roster into a mounted viewer keeps `focusedDay` — a bare
  // INDEX. Carrying an index into an unrelated calendar silently retargets the
  // user to whatever date now happens to occupy that slot, and the persistence
  // effect below then writes that unrelated date as if they had chosen it. A
  // clamp only guarded the shorter-calendar case; an equal or longer replacement
  // sailed through.
  //
  // So re-resolve by DATE IDENTITY on every calendar change, reusing the same
  // `resolveFocusedDay` fallback chain (that ISO → today → first day) the initial
  // restore uses. Done during render rather than in an effect, per React's
  // "adjusting state when a prop changes" guidance, so no frame ever displays the
  // wrong day and the persist effect never observes the stale value.
  const [seenCalendar, setSeenCalendar] = useState(calendar);
  if (calendar !== seenCalendar) {
    const priorIso = seenCalendar[focusedDay]?.iso ?? null;
    setSeenCalendar(calendar);
    setFocusedDay(resolveFocusedDay(calendar, { lens, focusedIso: priorIso }));
  }

  // Persist lens + focused DATE (not index — see `view-preference.ts`) whenever
  // either changes, so a reload restores the view the user left.
  useEffect(() => {
    writeViewPreference({ lens, focusedIso: calendar[focusedDay]?.iso ?? null });
  }, [lens, focusedDay, calendar]);

  const onFocusDay = useCallback((dateIdx: number) => setFocusedDay(dateIdx), []);

  // Switching lenses cancels an open cell selection: no edit occurred, so nothing
  // is lost (Core Flows Flow 2). Drag state is grid-local and resets on unmount.
  const onLensChange = useCallback(
    (next: RosterLens) => {
      setLens(next);
      if (editing !== undefined) editing.selectCell(null);
    },
    [editing],
  );

  // The editing callbacks the grid consumes, memoized so the grid does not
  // re-render on every viewer state change.
  const gridEditing = useMemo(
    () =>
      editing === undefined
        ? undefined
        : {
            selectedCell: editing.selectedCell,
            onSelectCell: editing.selectCell,
            onSwapCells: editing.swapCells,
          },
    [editing],
  );

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="roster-viewer">
      {/* Header: lens toggle + provenance + undo (editing only). */}
      <div className="flex flex-wrap items-end gap-4">
        <div className="min-w-0 flex-1" style={{ flexBasis: "440px" }}>
          <ProvenanceBanner provenance={provenance} summary={summary} />
        </div>
        {editing !== undefined ? (
          <Button
            variant="ghost"
            size="sm"
            className="border border-line"
            onClick={editing.undo}
            disabled={!editing.canUndo}
            title={editing.canUndo ? "Undo last edit" : "Nothing to undo"}
            data-testid="roster-undo"
          >
            <FaRotateLeft className="size-3.5" aria-hidden /> Undo
          </Button>
        ) : null}
        <LensToggle lens={lens} onLensChange={onLensChange} />
      </div>

      {/* Edit bar: only in the Grid lens when a cell is selected. */}
      {editing !== undefined && lens === "grid" && editing.selectedCell !== null ? (
        <RosterEditBar
          context={document.context}
          selected={editing.selectedCell}
          current={currentDays[editing.selectedCell.personIdx]?.[editing.selectedCell.dateIdx]}
          onSetCell={editing.setCell}
          onCancel={() => editing.selectCell(null)}
        />
      ) : null}

      {/* Active lens. */}
      {lens === "grid" ? (
        <RosterGrid
          context={document.context}
          currentDays={currentDays}
          ramp={ramp}
          coverage={coverage}
          tallies={tallies}
          editing={gridEditing}
        />
      ) : null}
      {lens === "coverage" ? (
        <RosterCoverage
          context={document.context}
          ramp={ramp}
          coverage={coverage}
          model={model}
          requirements={requirements}
          width={width}
        />
      ) : null}
      {lens === "day" ? (
        <RosterDay
          context={document.context}
          currentDays={currentDays}
          ramp={ramp}
          coverage={coverage}
          model={model}
          requirements={requirements}
          focusedDay={focusedDay}
          onFocusDay={onFocusDay}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Provenance banner — solver status + score "as solved" + edited-since indicator.
// ---------------------------------------------------------------------------

function ProvenanceBanner({
  provenance,
  summary,
}: {
  provenance: ReturnType<typeof buildProvenanceView>;
  summary: ReturnType<typeof summariseRequirements>;
}) {
  const statusTone = provenance.solverStatus === "OPTIMAL" ? "text-successink" : "text-warnink";
  return (
    <div className="flex flex-wrap items-center gap-3" data-testid="roster-provenance">
      <span
        className={cn(
          "inline-flex items-center gap-2 border px-3 py-1.5 font-ui text-meta font-bold uppercase tracking-[0.04em]",
          provenance.solverStatus === "OPTIMAL"
            ? "border-success bg-successtint text-successink"
            : "border-warn bg-warntint text-warnink",
        )}
      >
        {provenance.solverStatus}
      </span>
      <span className="font-mono text-body font-semibold text-ink">
        Score: <span className={statusTone}>{provenance.score ?? "—"}</span>
      </span>
      <span className="text-meta text-ink3">as solved</span>
      {provenance.editedSinceSolve ? (
        <span className="inline-flex items-center gap-1.5 rounded-chip border border-line2 bg-panel px-2 py-1 font-ui text-label font-semibold uppercase tracking-[0.03em] text-ink2">
          edited since solve
        </span>
      ) : null}
      <span className="text-meta text-ink2" data-testid="roster-coverage-summary">
        {coverageSummaryText(summary)}
      </span>
    </div>
  );
}

/**
 * The roster-level coverage sentence, stated against the schedule's own DECLARED
 * requirements.
 *
 * The claim is always scoped to what could actually be evaluated. "All
 * requirements met" over a roster with unresolvable equations would read as an
 * all-clear nothing issued, so unavailable equations are named rather than
 * absorbed, and a roster with nothing checkable makes no staffing claim at all.
 */
function coverageSummaryText(summary: ReturnType<typeof summariseRequirements>): string {
  if (!summary.anyCheckable) return "Coverage unavailable";
  const unavailable = summary.unavailable > 0 ? ` · ${summary.unavailable} unavailable` : "";
  if (summary.mismatched === 0) {
    return summary.unavailable > 0
      ? `All checkable requirements met${unavailable}`
      : "All requirements met";
  }
  return `${summary.mismatched} requirement${summary.mismatched === 1 ? "" : "s"} not met${unavailable}`;
}

// ---------------------------------------------------------------------------
// Lens toggle — Grid / Coverage / Day segmented control.
// ---------------------------------------------------------------------------

function LensToggle({
  lens,
  onLensChange,
}: {
  lens: RosterLens;
  onLensChange: (lens: RosterLens) => void;
}) {
  // Base UI's ToggleGroup owns selection: the group holds the value and the
  // items derive `data-pressed`/`aria-pressed` from it. Driving each item with
  // its own `pressed` prop instead would leave the group's own (empty) state
  // authoritative, so the control would look selected but never announce it.
  // Going through the group is also what gives us roving focus and arrow-key
  // navigation for free.
  return (
    <ToggleGroup
      segmented
      aria-label="Roster lens"
      data-testid="roster-lens-toggle"
      value={[lens]}
      onValueChange={(value: string[]) => {
        // `toggleMultiple` is off, so this is at most one entry. An empty array
        // means the user pressed the already-active lens; keep it selected
        // rather than leaving no lens rendered.
        const next = value[0];
        if (next !== undefined) onLensChange(next as RosterLens);
      }}
    >
      {LENSES.map(({ lens: value, icon: Icon, label }) => (
        <ToggleGroupItem key={value} value={value} data-testid={`roster-lens-${value}`}>
          <Icon className="size-3.5" aria-hidden />
          {label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

const LENSES: ReadonlyArray<{ lens: RosterLens; icon: IconType; label: string }> = [
  { lens: "grid", icon: FaTableCells, label: "Grid" },
  { lens: "coverage", icon: FaLayerGroup, label: "Coverage" },
  { lens: "day", icon: FaCalendarDay, label: "Day" },
];
