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

import { useCallback, useMemo, useState, type DragEvent, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { FaChevronDown } from "@/components/icons";
import { typedIdKey, type EditCoordinate } from "@/lib/roster";
import type { RosterContext, RosterDayGrid, RosterDayState, RosterCalendarDay } from "@/lib/roster";
import {
  classifyShiftFamily,
  dateLabel,
  dateTitle,
  isNewMonth,
  rosterSpanTitle,
  SHIFT_FAMILY_GLYPH,
  SHIFT_FAMILY_LABEL,
  SHIFT_FAMILY_ORDER,
  SHIFT_FAMILY_RAMP,
  shiftTimeRange,
  uniformShiftRequirement,
  type CoverageGrid,
  type ShiftFamily,
  type ShiftRampEntry,
  type Tallies,
} from "@/lib/roster-viewer";
import { ShiftChip } from "./shift-chip";
import { useRosterContentWidth } from "./roster-content-width";
import { LEGEND_WRAP_THRESHOLD } from "./use-container-width";

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
  /** Pre-computed exact-shift plane (per-day, per-shift staffed and people). */
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
    <div className="flex min-w-0 flex-col gap-3">
      <GridToolbar context={context} isEditing={isEditing} />
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
                    headerColumnBackground(day),
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
                  {/* The prototype's holiday marker. It SUPPLEMENTS the stripe and
                    the header title; the accessible name below carries the whole
                    date + status, so neither colour nor texture is ever the only
                    signal that this is a public holiday. */}
                  {day.holiday ? (
                    <span
                      data-testid="roster-grid-holiday"
                      className="mx-auto mt-1 block size-1.5 rounded-full bg-warn"
                      aria-hidden
                    />
                  ) : null}
                  <span className="sr-only">{dateTitle(day)}</span>
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
                  <span className="font-mono text-label font-bold text-ink2">
                    {String(shift.id)}
                  </span>
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
              {/* Weekend rest — the prototype's fairness scan column, restored.
                Informational: no scenario constraint says a nurse is owed a
                weekend off, so zero is flagged for attention, never as an error. */}
              <th
                title="Weekend rest days (0 = worked every weekend day — check fairness)"
                className="sticky top-0 z-[3] border-b-[2px] border-l border-l-line2 border-line bg-panel text-center"
                style={{ minWidth: 40, padding: "8px 4px" }}
              >
                <span className="font-mono text-label font-bold text-ink">W·off</span>
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
                      onKeyDown={
                        isEditing ? (e) => onCellKeyDown(personIdx, dateIdx, e) : undefined
                      }
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
                <td
                  data-testid="roster-weekend-rest"
                  data-weekend-rest={tallies[personIdx]?.weekendRest ?? 0}
                  title={`${String(person.id)} — ${tallies[personIdx]?.weekendRest ?? 0} weekend rest days`}
                  className={cn(
                    "border-b border-l border-l-line2 border-line2 text-center font-mono text-meta font-bold",
                    (tallies[personIdx]?.weekendRest ?? 0) === 0
                      ? "bg-errortint text-errorink"
                      : "text-ink2",
                  )}
                >
                  {tallies[personIdx]?.weekendRest ?? 0}
                </td>
              </tr>
            ))}
          </tbody>
          {/* Per-day staffed counts vs minimum. */}
          {/* Per-day staffed counts. The count is ALWAYS shown — it is a real fact
            about the roster — while a required target appears only where the
            scenario declares one for this exact shift on every day. Ward 8's
            group targets are never copied down onto a member lane: that is the
            invented per-shift quota this closure forbids. */}
          <tfoot>
            {shiftTypes.map((shift, shiftIdx) => {
              // The LANE label can only state a target every day agrees on; a
              // date-scoped requirement makes it vary, and the per-day cells below
              // carry that truth cell by cell.
              const required = uniformShiftRequirement(coverage, shiftIdx);
              const time = shiftTimeRange(shift);
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
                      ) : time !== null ? (
                        <span className="font-mono text-label font-medium text-ink3">{time}</span>
                      ) : null}
                    </div>
                  </td>
                  {calendar.map((day, dateIdx) => {
                    const cell = coverage[dateIdx]?.shifts[shiftIdx];
                    const staffed = cell?.staffed ?? 0;
                    // Colour alone must not carry the Short state (DESIGN.md).
                    // The number is identical whether short or not, so without a
                    // title/accessible name the only difference is the red fill.
                    const label =
                      cell?.required == null
                        ? `Staffed ${staffed}, no target declared for this shift`
                        : cell.short
                          ? `Short: staffed ${staffed}, required ${cell.required}`
                          : `Staffed ${staffed}, required ${cell.required}`;
                    return (
                      <td
                        key={day.iso}
                        title={label}
                        aria-label={label}
                        data-short={cell?.short === true ? "true" : "false"}
                        className={cn(
                          "text-center font-mono text-meta font-bold",
                          cell?.short === true ? "text-errorink bg-errortint" : "text-ink2",
                          columnBackground(day),
                        )}
                        style={{ height: 32, minWidth: 40 }}
                      >
                        {staffed}
                      </td>
                    );
                  })}
                  <td
                    colSpan={shiftTypes.length + 3}
                    className="border-l-[2px] border-l-line border-t border-t-line2 bg-panel"
                  />
                </tr>
              );
            })}
          </tfoot>
        </table>
      </div>
    </div>
  );
}

/**
 * The compact Grid toolbar the prototype carries above the scroller, and the
 * single largest thing the shipped Grid was missing.
 *
 * It sits OUTSIDE the dense table so it never disturbs the 66vh internal
 * scroller or the sticky 5/3/2 planes, and it is deliberately NOT another
 * heading: the route already owns the page heading, and competing display-size
 * headings were the fidelity review's strongest hierarchy finding.
 *
 * The legend groups every AUTHORED shift into its computed colour family
 * (Morning/Evening/Night/Long day) rather than keying each id individually.
 * Family is derived from each shift's own startTime/duration
 * (`classifyShiftFamily`), never from its id string — a ward's naming
 * convention (a `+` senior twin, or anything else) is never inspected, and two
 * ids sharing a family colour is intentional, not overflow (DESIGN.md §2
 * "Shift colour palette").
 */
function GridToolbar({ context, isEditing }: { context: RosterContext; isEditing: boolean }) {
  const { width } = useRosterContentWidth();
  const entries = useMemo(() => buildLegendEntries(context), [context]);
  // A width of null (pre-mount) or 0 (an unlaid-out box: jsdom, `display:none`)
  // is not a MEASUREMENT, so it must never drive the layout choice. Both fall
  // back to the wide key, matching the roster-content provider's own
  // conservative desktop pre-mount guess. In a real browser the observer's
  // mount-time read lands during the same commit, before paint, so a narrow host
  // never flashes the wide key first.
  const measured = width ?? 0;
  const wide = measured <= 0 || measured >= LEGEND_WRAP_THRESHOLD;

  return (
    <div data-testid="roster-grid-toolbar" className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span
          data-testid="roster-grid-span"
          className="font-mono text-meta font-semibold text-ink2"
        >
          {rosterSpanTitle(context.calendar)}
        </span>
        <span className="text-meta text-ink3">{context.calendar.length} days</span>
        {isEditing ? (
          <span data-testid="roster-grid-guidance" className="text-meta text-ink3">
            Select a cell to change · drag to swap
          </span>
        ) : null}
      </div>
      {wide ? (
        <GridLegend entries={entries} />
      ) : (
        // Constrained hosts get progressive disclosure, not a second horizontal
        // scroller. `<details>` is the standard element for exactly this: it is
        // keyboard operable and announced as a disclosure with no ARIA of our
        // own, and its panel holds the SAME complete key the wide layout renders
        // — every authored id, its hours, Leave and Off/rest.
        <details data-testid="roster-grid-legend-disclosure" className="group min-w-0">
          <summary
            data-testid="roster-grid-legend-summary"
            className={cn(
              "inline-flex h-control-sm w-fit cursor-pointer list-none items-center gap-2 rounded-pill",
              "border border-line bg-surface px-3 text-meta font-medium text-ink shadow-1",
              "transition-[background-color,box-shadow,color] duration-fast outline-none",
              "pointer-coarse:min-h-touch hover:bg-panel-alt",
              "focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-brand",
              "[&::-webkit-details-marker]:hidden",
            )}
          >
            <FaChevronDown
              className="size-3 text-ink3 transition-transform duration-fast group-open:rotate-180"
              aria-hidden
            />
            Shift key
          </summary>
          <GridLegend entries={entries} className="mt-2" />
        </details>
      )}
    </div>
  );
}

/** One legend row, wrapping. Never a scroller — at either width (G8). */
function GridLegend({ entries, className }: { entries: LegendEntry[]; className?: string }) {
  return (
    <div
      data-testid="roster-grid-legend"
      // `min-w-0` stays load-bearing: a non-wrapping row inside a default
      // `min-width:auto` flex item pushes the DOCUMENT into horizontal scroll
      // instead of containing itself (DESIGN.md §6 rule 6).
      className={cn("flex min-w-0 flex-wrap gap-x-3 gap-y-2", className)}
    >
      {entries.map((entry) => (
        <span
          key={entry.key}
          data-testid="roster-grid-legend-item"
          data-shift={entry.shift}
          title={entry.title}
          aria-label={entry.title}
          className="inline-flex shrink-0 items-center gap-1.5 text-label font-medium text-ink2"
        >
          <span
            className={cn(
              "inline-flex h-5 min-w-[26px] items-center justify-center px-1.5 font-mono text-label",
              entry.bare ? "text-ink3" : "rounded-chip font-bold",
            )}
            style={entry.bare ? undefined : { backgroundColor: entry.fill, color: entry.ink }}
            aria-hidden
          >
            {entry.glyph}
          </span>
          {entry.text !== null ? (
            <span className="whitespace-nowrap font-mono">{entry.text}</span>
          ) : null}
        </span>
      ))}
    </div>
  );
}

/** One legend entry, in the exact order the key reads. */
interface LegendEntry {
  key: string;
  /** `data-shift` — the family glyph (`AM`/`PM`/`N`/`LD`), or `LV` / `OFF`. */
  shift: string;
  /** The chip glyph. */
  glyph: string;
  /** The text beside the chip: the family name, `Leave`, or `Off / rest`. */
  text: string | null;
  /** The whole entry's accessible name and tooltip. */
  title: string;
  fill: string;
  ink: string;
  /** Rest is a bare dot with no chip fill, mirroring its cell. */
  bare: boolean;
}

/**
 * The ONE legend-item builder (G8, revised). Both the wide wrapped key and the
 * `Shift key` disclosure render this same list, so a constrained host can
 * never be served a shortened, regrouped, or differently coloured version of
 * the key. The key lists one row per colour FAMILY present in this scenario's
 * shift catalog, not one row per authored id — colour is shared across a
 * family on purpose (DESIGN.md §5).
 */
function buildLegendEntries(context: RosterContext): LegendEntry[] {
  const present = new Set<ShiftFamily>();
  for (const shift of context.shiftTypes) {
    present.add(classifyShiftFamily(shift));
  }
  const entries: LegendEntry[] = SHIFT_FAMILY_ORDER.filter((family) => present.has(family)).map(
    (family) => {
      const entry = SHIFT_FAMILY_RAMP[family];
      return {
        key: `legend:${family}`,
        shift: SHIFT_FAMILY_GLYPH[family],
        glyph: SHIFT_FAMILY_GLYPH[family],
        text: SHIFT_FAMILY_LABEL[family],
        title: SHIFT_FAMILY_LABEL[family],
        fill: entry.fill,
        ink: entry.ink,
        bare: false,
      };
    },
  );
  entries.push({
    key: "legend:LV",
    shift: "LV",
    glyph: "LV",
    text: "Leave",
    title: "Leave",
    fill: "var(--panel)",
    ink: "var(--ink3)",
    bare: false,
  });
  entries.push({
    key: "legend:OFF",
    shift: "OFF",
    glyph: "·",
    text: "Off / rest",
    title: "Off / rest",
    fill: "transparent",
    ink: "var(--ink3)",
    bare: true,
  });
  return entries;
}

/** Column background: weekend → panel, holiday → striped, ordinary → transparent. */
function columnBackground(day: RosterCalendarDay): string {
  if (day.holiday) return HOLIDAY_STRIPE;
  if (day.weekend) return "bg-panel";
  return "bg-transparent";
}

function headerColumnBackground(day: RosterCalendarDay): string {
  if (day.holiday) return HOLIDAY_STRIPE;
  if (day.weekend) return "bg-panel";
  return "bg-surface";
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
