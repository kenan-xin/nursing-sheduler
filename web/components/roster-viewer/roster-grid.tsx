"use client";

// Roster Grid lens (F4).
//
// The densest surface in the system, and the one with the most specific rules
// (DESIGN.md §5 "Roster grid"). This is a READ-ONLY grid — editing is F5.
//
// Geometry contract (load-bearing — every rule is tested):
//   • The roster CARD is the scroller: `overflow:auto`, `max-height:66vh`. Sticky
//     offsets resolve against the card, not the page.
//   • Sticky z-order: date/summary headers z:3, body first column z:2, corner z:5.
//     Headers below the first column makes nurse names paint over the date row.
//   • Both sticky edges carry `--sh-edge`.
//   • Header bottom rule: `2px solid --line` on EVERY header cell including corner.
//   • Chips: 34×28, `--r-chip`, no border.
//   • Columns: weekends `--panel`; ordinary `transparent`; holidays striped;
//     `1px --line` left edge every 7th column.
//   • Rows hover to `--panel-alt`; cell padding 4px.

import { useCallback, useState, type DragEvent, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { typedIdKey, type EditCoordinate } from "@/lib/roster";
import type { RosterContext, RosterDayGrid, RosterDayState, RosterCalendarDay } from "@/lib/roster";
import {
  dateLabel,
  dateTitle,
  isNewMonth,
  type CoverageGrid,
  type ShiftRampEntry,
  type Tallies,
} from "@/lib/roster-viewer";
import { ShiftChip } from "./shift-chip";

/** Editing hooks the grid consumes when editing is enabled (F5). */
export interface RosterGridEditing {
  selectedCell: EditCoordinate | null;
  onSelectCell: (coordinate: EditCoordinate | null) => void;
  onSwapCells: (a: EditCoordinate, b: EditCoordinate) => void;
}

export interface RosterGridProps {
  context: RosterContext;
  /** The CURRENT assignments (solved + edits applied). */
  currentDays: RosterDayGrid;
  /** The shift ramp, keyed by typed shift id. */
  ramp: Map<string, ShiftRampEntry>;
  /** Pre-computed coverage grid (per-day, per-shift staffed vs minimum). */
  coverage: CoverageGrid;
  /** Pre-computed per-nurse tallies. */
  tallies: Tallies;
  /** When present, the grid is editable: cells select and drag-swap. */
  editing?: RosterGridEditing;
}

const HOLIDAY_STRIPE =
  "bg-[repeating-linear-gradient(135deg,var(--warntint)_0_3px,var(--surface)_3px_9px)]";

export function RosterGrid({
  context,
  currentDays,
  ramp,
  coverage,
  tallies,
  editing,
}: RosterGridProps) {
  const people = context.people;
  const calendar = context.calendar;
  const shiftTypes = context.shiftTypes;
  const isEditing = editing !== undefined;

  // Drag-swap tracks the cell a drag started on. HTML5 drag-and-drop is a
  // pointer/desktop enhancement (Core Flows Flow 3); tap-to-set remains the
  // universal path and the only required touch affordance.
  const [dragFrom, setDragFrom] = useState<EditCoordinate | null>(null);

  const onCellClick = useCallback(
    (personIdx: number, dateIdx: number) => {
      if (editing === undefined) return;
      editing.onSelectCell({ personIdx, dateIdx });
    },
    [editing],
  );

  // Keyboard activation: Enter/Space opens the edit bar on the focused cell, the
  // universal path that does not depend on a pointer (Core Flows Flow 2). The
  // cells are focusable (`tabIndex={0}`) and announced as buttons so keyboard and
  // AT users can select without a tap.
  const onCellKeyDown = useCallback(
    (personIdx: number, dateIdx: number, event: KeyboardEvent<HTMLTableCellElement>) => {
      if (editing === undefined) return;
      if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
        event.preventDefault();
        editing.onSelectCell({ personIdx, dateIdx });
      }
    },
    [editing],
  );

  const onCellDragStart = useCallback(
    (personIdx: number, dateIdx: number, event: DragEvent<HTMLTableCellElement>) => {
      if (editing === undefined) return;
      // A visible drag image is required for the browser to show the drag; the
      // dataTransfer payload is what makes drop fire on the target cell.
      setDragFrom({ personIdx, dateIdx });
      event.dataTransfer.effectAllowed = "move";
      try {
        event.dataTransfer.setData("text/plain", `${personIdx}:${dateIdx}`);
      } catch {
        // Some browsers restrict setData during tests; the drag-state is enough.
      }
    },
    [editing],
  );

  const onCellDragOver = useCallback(
    (event: DragEvent<HTMLTableCellElement>) => {
      if (dragFrom === null) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    },
    [dragFrom],
  );

  const onCellDrop = useCallback(
    (personIdx: number, dateIdx: number, event: DragEvent<HTMLTableCellElement>) => {
      if (editing === undefined || dragFrom === null) return;
      event.preventDefault();
      editing.onSwapCells(dragFrom, { personIdx, dateIdx });
      setDragFrom(null);
    },
    [editing, dragFrom],
  );

  const onCellDragEnd = useCallback(() => setDragFrom(null), []);

  const isSelected = (personIdx: number, dateIdx: number): boolean =>
    editing?.selectedCell !== null &&
    editing?.selectedCell !== undefined &&
    editing.selectedCell.personIdx === personIdx &&
    editing.selectedCell.dateIdx === dateIdx;

  return (
    <div
      data-testid="roster-grid"
      className={cn(
        // The card IS the scroller (DESIGN.md §5).
        "overflow-auto rounded-card border border-line bg-surface shadow-1",
      )}
      style={{ maxHeight: "66vh" }}
    >
      <table className="border-collapse" style={{ minWidth: "max-content" }}>
        <thead>
          <tr>
            {/* Corner: sticky top+left, z:5 (highest). */}
            <th
              className={cn(
                "sticky left-0 top-0 z-[5] border-b-[2px] border-line bg-panel",
                "text-left font-ui text-label font-semibold uppercase tracking-[0.03em] text-ink2",
              )}
              style={{ boxShadow: "var(--sh-edge)", minWidth: 170, padding: "10px 14px" }}
            >
              Nurse
            </th>
            {/* Date headers: sticky top, z:3. */}
            {calendar.map((day, dateIdx) => (
              <th
                key={day.iso}
                title={dateTitle(day)}
                className={cn(
                  "sticky top-0 z-[3] border-b-[2px] border-line text-center",
                  columnBackground(day),
                  dateIdx > 0 && isNewMonth(calendar, dateIdx) && "border-l border-l-line",
                )}
                style={{ minWidth: 40, padding: "8px 4px" }}
              >
                <div
                  className={cn(
                    "font-mono text-label-md font-semibold leading-none",
                    day.holiday ? "text-warn" : day.weekend ? "text-ink3" : "text-ink",
                  )}
                >
                  {dateLabel(calendar, dateIdx)}
                </div>
                <div className="mt-0.5 font-mono text-label font-medium text-ink3">
                  {day.weekday}
                </div>
              </th>
            ))}
            {/* Tally column headers: sticky top, z:3. */}
            {shiftTypes.map((shift, shiftIdx) => (
              <th
                key={typedIdKey(shift.id)}
                title={`${String(shift.id)} shifts this period`}
                className={cn(
                  "sticky top-0 z-[3] border-b-[2px] border-line bg-panel text-center",
                  shiftIdx === 0 && "border-l-[2px] border-l-line",
                  shiftIdx > 0 && "border-l border-l-line2",
                )}
                style={{ minWidth: 36, padding: "8px 4px" }}
              >
                <span className="font-mono text-label font-bold text-ink2">{String(shift.id)}</span>
              </th>
            ))}
            <th
              title="Rest (OFF) days this period"
              className="sticky top-0 z-[3] border-b-[2px] border-l border-l-line2 border-line bg-panel text-center"
              style={{ minWidth: 36, padding: "8px 4px" }}
            >
              <span className="font-mono text-label font-bold text-ink2">Off</span>
            </th>
            <th
              title="Leave days this period"
              className="sticky top-0 z-[3] border-b-[2px] border-l border-l-line2 border-line bg-panel text-center"
              style={{ minWidth: 36, padding: "8px 4px" }}
            >
              <span className="font-mono text-label font-bold text-ink2">LV</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {people.map((person, personIdx) => (
            <tr key={typedIdKey(person.id)} className="hover:bg-panel-alt">
              {/* First column: sticky left, z:2. A row header, not a data cell —
                  it names every cell in the row, which is what lets a screen
                  reader announce "Ada Lovelace, Mon 3" instead of a bare chip. */}
              <th
                scope="row"
                className={cn("sticky left-0 z-[2] border-b border-line2 bg-surface text-left")}
                style={{ boxShadow: "var(--sh-edge)", padding: "6px 14px" }}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "inline-flex size-[26px] shrink-0 items-center justify-center rounded-[50%] bg-panel font-mono text-label font-bold text-ink2",
                    )}
                    aria-hidden
                  >
                    {initials(String(person.id))}
                  </span>
                  <span className="min-w-0 whitespace-nowrap text-meta font-semibold text-ink">
                    {String(person.id)}
                  </span>
                </div>
              </th>
              {/* Assignment cells. */}
              {calendar.map((day, dateIdx) => {
                const cellDay = currentDays[personIdx]?.[dateIdx];
                if (cellDay === undefined) return <td key={day.iso} />;
                const selected = isEditing && isSelected(personIdx, dateIdx);
                return (
                  <td
                    key={day.iso}
                    onClick={isEditing ? () => onCellClick(personIdx, dateIdx) : undefined}
                    onKeyDown={isEditing ? (e) => onCellKeyDown(personIdx, dateIdx, e) : undefined}
                    draggable={isEditing}
                    onDragStart={
                      isEditing ? (e) => onCellDragStart(personIdx, dateIdx, e) : undefined
                    }
                    onDragOver={isEditing ? onCellDragOver : undefined}
                    onDrop={isEditing ? (e) => onCellDrop(personIdx, dateIdx, e) : undefined}
                    onDragEnd={isEditing ? onCellDragEnd : undefined}
                    tabIndex={isEditing ? 0 : undefined}
                    role={isEditing ? "button" : undefined}
                    aria-label={
                      isEditing
                        ? `${String(person.id)} ${day.weekday} ${dateLabel(
                            calendar,
                            dateIdx,
                          )} — ${dayStateAria(cellDay)}`
                        : undefined
                    }
                    title={
                      isEditing
                        ? "Tap or press Enter to set · drag onto another cell to swap"
                        : undefined
                    }
                    className={cn(
                      "text-center",
                      columnBackground(day),
                      dateIdx > 0 && isNewMonth(calendar, dateIdx) && "border-l border-l-line",
                      isEditing && "cursor-pointer",
                      selected && "outline outline-2 -outline-offset-2 outline-brand",
                    )}
                    style={{ padding: "4px" }}
                  >
                    <ShiftChip
                      day={cellDay}
                      ramp={
                        cellDay.kind === "shift"
                          ? (ramp.get(typedIdKey(cellDay.shiftId)) ?? null)
                          : null
                      }
                    />
                  </td>
                );
              })}
              {/* Tally cells. */}
              {tallies[personIdx]?.shiftCounts.map((count, shiftIdx) => (
                <td
                  key={typedIdKey(shiftTypes[shiftIdx].id)}
                  className={cn(
                    "border-b border-line2 text-center font-mono text-meta font-bold",
                    shiftIdx === 0 && "border-l-[2px] border-l-line",
                    shiftIdx > 0 && "border-l border-l-line2",
                    count === 0 ? "text-ink3" : "text-ink2",
                  )}
                >
                  {count}
                </td>
              ))}
              <td className="border-b border-l border-l-line2 border-line2 text-center font-mono text-meta font-bold text-ink2">
                {tallies[personIdx]?.off ?? 0}
              </td>
              <td className="border-b border-l border-l-line2 border-line2 text-center font-mono text-meta font-bold text-ink2">
                {tallies[personIdx]?.leave ?? 0}
              </td>
            </tr>
          ))}
        </tbody>
        {/* Per-day staffed counts vs minimum. */}
        <tfoot>
          {shiftTypes.map((shift, shiftIdx) => {
            const minimum = context.baselineMinimums[shiftIdx];
            const isAvailable = !("unavailable" in minimum);
            const required = isAvailable ? minimum.required : null;
            return (
              <tr key={typedIdKey(shift.id)}>
                <td
                  className={cn(
                    "sticky left-0 z-[2] bg-panel",
                    shiftIdx === 0 ? "border-t-[2px] border-t-line" : "border-t border-t-line2",
                  )}
                  style={{ boxShadow: "var(--sh-edge)", padding: "8px 12px" }}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={cn("size-2.5 shrink-0 rounded-[3px]")}
                      style={{
                        backgroundColor: ramp.get(typedIdKey(shift.id))?.bar ?? "var(--line)",
                      }}
                      aria-hidden
                    />
                    <span className="whitespace-nowrap text-meta font-bold text-ink">
                      {String(shift.id)}
                    </span>
                    {required !== null ? (
                      <span className="font-mono text-label font-medium text-ink3">
                        min {required}
                      </span>
                    ) : (
                      <span className="font-mono text-label font-medium text-ink3">n/a</span>
                    )}
                  </div>
                </td>
                {calendar.map((day, dateIdx) => {
                  const cell = coverage[dateIdx]?.shifts[shiftIdx];
                  if (cell === undefined || cell.status !== "available") {
                    return (
                      <td
                        key={day.iso}
                        className={cn(
                          "text-center font-mono text-label text-ink3",
                          columnBackground(day),
                        )}
                        style={{ height: 32, minWidth: 40 }}
                      >
                        —
                      </td>
                    );
                  }
                  // Colour alone must not carry the Short state (DESIGN.md).
                  // The number is identical whether short or not, so without a
                  // title/accessible name the only difference is the red fill.
                  const label = cell.short
                    ? `Short: staffed ${cell.staffed}, required ${cell.required}`
                    : `Staffed ${cell.staffed}, required ${cell.required}`;
                  return (
                    <td
                      key={day.iso}
                      title={label}
                      aria-label={label}
                      data-short={cell.short ? "true" : "false"}
                      className={cn(
                        "text-center font-mono text-meta font-bold",
                        cell.short ? "text-errorink bg-errortint" : "text-ink2",
                        columnBackground(day),
                      )}
                      style={{ height: 32, minWidth: 40 }}
                    >
                      {cell.staffed}
                    </td>
                  );
                })}
                <td
                  colSpan={shiftTypes.length + 2}
                  className="border-l-[2px] border-l-line border-t border-t-line2 bg-panel"
                />
              </tr>
            );
          })}
        </tfoot>
      </table>
    </div>
  );
}

/** Column background: weekend → panel, holiday → striped, ordinary → transparent. */
function columnBackground(day: RosterCalendarDay): string {
  if (day.holiday) return HOLIDAY_STRIPE;
  if (day.weekend) return "bg-panel";
  return "bg-transparent";
}

/**
 * A spoken label for a cell's day-state (OFF → "off", Leave → "leave", worked →
 * the shift id). Mirrors `dayStateDisplay` except OFF is named rather than blank
 * so a screen reader announces the rest day.
 */
function dayStateAria(day: RosterDayState): string {
  if (day.kind === "off") return "off";
  if (day.kind === "leave") return "leave";
  return String(day.shiftId);
}

/** Two-letter initials from a name, matching the prototype's resolver. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const second = parts[1]?.[0] ?? "";
  return (first + second).toUpperCase() || "?";
}
