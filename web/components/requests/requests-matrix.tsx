"use client";

// Shift Requests matrix (T11; spec 04 FR-SR-03..16, prototype ScreenRequests.dc.html
// lines ~89-128). Presentational + gesture-callback-driven: rows/columns/data come in
// as props, cell/history clicks and quick-paint pointer events go out as callbacks. The
// container owns the store wiring, staged-drag state, and the global pointer-up that
// commits a gesture. Row-virtualized (~100 people) via `@tanstack/react-virtual`; the
// bounded column set (history + date-group + date-item) renders fully per column, so
// the sticky Nurse column and sticky header stay simple `position: sticky` cells.

import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { DateRef, PersonRef, UiPerson, UiRequestCell } from "@/lib/scenario";
import {
  aggregateSign,
  cellAlpha,
  cellDisplay,
  cellPreferenceOf,
  historyValueAt,
  isHistorySlotClickable,
  type RequestColumn,
  type RequestRow,
  type ShiftTypeOrderIndex,
} from "@/components/requests/requests-model";
import { FaBriefcase, FaCalendar, FaLayerGroup, FaMugHot, type IconType } from "@/components/icons";
import { isSingaporePublicHoliday, utcDayOfWeek } from "@/lib/dates";
import { cn } from "@/lib/utils";

export interface RequestsMatrixProps {
  /** `buildRows(staffGroups, staff)` — groups first. */
  rows: RequestRow[];
  /** `buildColumns(range, dateGroups)` — date-group cols then date-item cols. */
  columns: RequestColumn[];
  /** To resolve per-person history via `historyValueAt`/`isHistorySlotClickable`. */
  people: UiPerson[];
  /** `historyLayout(people).count`. */
  historyCount: number;
  /** `historyColumnLabels(count)` — leftmost H-{count} … rightmost H-1. */
  historyLabels: string[];
  /** Source for `cellPreferenceSet`. */
  reqData: UiRequestCell[];
  shiftTypeOrderIndex: ShiftTypeOrderIndex;
  mode: "normal" | "quick";
  /** `JSON.stringify([person, colRef])` currently staged (drag highlight); optional. */
  stagedKeys?: Set<string>;
  /**
   * `origin` is the exact DOM element the user activated. The coordinate stays
   * the domain identity; the element is carried separately so the container can
   * return focus to the very cell that opened the editor, rather than
   * re-deriving one by querying the document for a coordinate (which would find
   * a different node after a re-render, or none at all once virtualization has
   * recycled the row).
   */
  onCellClick(person: PersonRef, colRef: DateRef, origin: HTMLElement): void;
  onHistoryClick(person: PersonRef, columnIndex: number, origin: HTMLElement): void;
  onCellPointerDown(person: PersonRef, colRef: DateRef): void;
  onCellPointerEnter(person: PersonRef, colRef: DateRef): void;
  onHistoryPointerDown(person: PersonRef, columnIndex: number): void;
  onHistoryPointerEnter(person: PersonRef, columnIndex: number): void;
}

const ROW_HEIGHT = 40;
/**
 * Coarse-pointer row height. The matrix is a dense data grid (40px rows on a
 * precise pointer, matching the prototype), but its normal-mode cells are real
 * `<button>`s, so the universal coarse-pointer target battery measures them. On
 * a touch device each row grows to the ratified 44px minimum (DESIGN.md §5
 * "Touch/coarse-pointer rule", decision D10) so a tap lands reliably; the dense
 * instrument character is preserved on desktop. The growth is pointer-aware,
 * not theme-aware, and applies to every cell in the row at once.
 */
const ROW_HEIGHT_COARSE = 44;
/** Header row is taller than a body row (ROW_HEIGHT) to fit the date-group icon +
 *  count, and the date-item weekday sub-label + holiday dot (prototype
 *  ScreenRequests.dc.html:98-102). */
const HEADER_ROW_HEIGHT = 52;
const NURSE_COL_WIDTH = 176;
const HISTORY_COL_WIDTH = 40;
/** Coarse history-column width: the 40px slot is below the 44px touch floor. */
const HISTORY_COL_COARSE = 44;
const DATE_GROUP_COL_WIDTH = 76;
const DATE_ITEM_COL_WIDTH = 56;

const WEEKDAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Prototype's holiday header stripe (ScreenRequests.dc.html `HOLIDAY_BG`). */
const HOLIDAY_STRIPE_BG =
  "repeating-linear-gradient(135deg, var(--warntint) 0px, var(--warntint) 3px, var(--surface) 3px, var(--surface) 9px)";

function columnWidth(column: RequestColumn): number {
  return column.kind === "date-group" ? DATE_GROUP_COL_WIDTH : DATE_ITEM_COL_WIDTH;
}

/** Shared empty membership for coordinates with no cells — avoids a fresh `[]`
 *  allocation per empty cell and keeps a stable reference across renders. */
const EMPTY_CELLS: readonly UiRequestCell[] = [];

// Actionable origins are native `<button type="button">` elements rendered as
// direct grid children. An earlier revision used `div role="button"` with a
// hand-written Enter/Space handler, on the stated grounds that a native button
// would "introduce its own box and defeat the sticky/virtual column math". A
// cold Chromium probe disproved that: substituting a native button on a live
// cell preserved the box exactly (56×40) along with its computed flex, padding,
// border, background, font and alignment. Tailwind's preflight already strips
// the UA button chrome, so the layout classes carry the geometry either way.
//
// The platform therefore supplies what the ARIA promise was re-implementing:
// pointer, Enter and Space activation, each exactly once, with Space's page
// scroll suppressed by the browser rather than by a `preventDefault` of ours.
//
// `type="button"` is explicit because the default is `submit`, and these buttons
// may sit inside a form on some future route.
//
// NOT changed here (see the accessibility priority decision): these remain
// ordinary tab stops, so the product-scale tab-order problem is unchanged and
// stays on the P4 scalable-grid backlog, as does the disconnected-origin focus
// lifecycle.

/** The `(person, date)` coordinate key. Matches the container's `stagedKeys`
 *  convention (`JSON.stringify([person, colRef])`, see `use-requests.ts`) so the
 *  same string serves both the cell-membership lookup and the staged-highlight
 *  check — and mirrors the strict `person`/`date` equality of the old
 *  `cellPreferenceSet` scan this Map replaces. */
export function coordKey(person: PersonRef, date: DateRef): string {
  return JSON.stringify([person, date]);
}

/** Index `reqData` by {@link coordKey} once, so a cell renders its membership via
 *  an O(1) `map.get` instead of a full-`reqData` scan (`cellPreferenceSet`). Push
 *  preserves `reqData` order within a coordinate, so `map.get(coordKey(p, d))`
 *  returns exactly what `cellPreferenceSet(reqData, p, d)` did (an absent key is
 *  the empty set). Pure and exported for the co-located refactor-parity test. */
export function buildCellsByCoord(reqData: readonly UiRequestCell[]): Map<string, UiRequestCell[]> {
  const map = new Map<string, UiRequestCell[]>();
  for (const cell of reqData) {
    const key = coordKey(cell.person, cell.date);
    const cells = map.get(key);
    if (cells) cells.push(cell);
    else map.set(key, [cell]);
  }
  return map;
}

/** Date-group header icon: ALL -> calendar, WEEKDAY -> briefcase, WEEKEND -> mug-hot,
 *  a custom group -> layer-group (prototype `_dateGroupCols` icon map). */
function dateGroupIcon(ref: DateRef, synthetic: boolean): IconType {
  if (!synthetic) return FaLayerGroup;
  switch (ref) {
    case "ALL":
      return FaCalendar;
    case "WEEKDAY":
      return FaBriefcase;
    case "WEEKEND":
      return FaMugHot;
    default:
      return FaLayerGroup;
  }
}

/** The reserved day-state precedence for display (LEAVE > OFF > worked; ticket's
 *  "Conflict / preservation boundary"). Coexisting cells are preserved in `reqData`
 *  (import fidelity) but rendered as one day-state with any worked prefs shadowed. */
function dayStateOf(cells: readonly UiRequestCell[]): "leave" | "off" | null {
  if (cells.some((c) => c.kind === "leave")) return "leave";
  if (cells.some((c) => c.kind === "off")) return "off";
  return null;
}

interface CellView {
  empty: boolean;
  dayState: "leave" | "off" | null;
  primaryText: string;
  shadowedCount: number;
}

function buildCellView(cells: readonly UiRequestCell[], orderIndex: ShiftTypeOrderIndex): CellView {
  if (cells.length === 0) {
    return { empty: true, dayState: null, primaryText: "", shadowedCount: 0 };
  }
  const dayState = dayStateOf(cells);
  if (dayState === "leave") {
    const shadowed = cells.filter((c) => c.kind !== "leave").length;
    return { empty: false, dayState, primaryText: "Leave", shadowedCount: shadowed };
  }
  if (dayState === "off") {
    const offCell = cells.find(
      (c): c is Extract<UiRequestCell, { kind: "off" }> => c.kind === "off",
    );
    const prefs = offCell ? [cellPreferenceOf(offCell)] : [];
    const display = cellDisplay(prefs, orderIndex);
    const shadowed = cells.filter((c) => c.kind !== "off").length;
    return {
      empty: false,
      dayState,
      primaryText: display.entries.map((e) => e.label).join(", ") || "Off",
      shadowedCount: shadowed,
    };
  }
  const prefs = cells.map(cellPreferenceOf);
  const display = cellDisplay(prefs, orderIndex);
  const more = display.moreCount > 0 ? ` +${display.moreCount} more` : "";
  return {
    empty: false,
    dayState: null,
    primaryText: display.entries.map((e) => e.label).join(", ") + more,
    shadowedCount: 0,
  };
}

interface CellVisual {
  className: string;
  style?: { opacity: number };
}

function cellVisual(view: CellView, cellsAt: readonly UiRequestCell[]): CellVisual {
  if (view.empty) return { className: "text-ink3" };
  if (view.dayState === "leave")
    // `--brandtint` is the selection/pin language, not a status tint, so the
    // Redundant Signal Rule's status-ink pairing does not govern it; brandink is
    // the correct paired foreground (DESIGN.md §6 reserves this pair for pins).
    return { className: "bg-brandtint text-brandink border border-brand" };
  if (view.dayState === "off")
    // errortint is a status tint: it must carry its paired --errorink, never the
    // base --error, so the cell stays legible in dark mode where the two differ
    // and status is never carried by colour alone (DESIGN.md §2).
    return { className: "bg-errortint text-errorink border border-error" };
  const prefs = cellsAt.map(cellPreferenceOf);
  const sign = aggregateSign(prefs);
  const alpha = cellAlpha(prefs);
  const base =
    sign === "all-positive"
      ? "bg-successtint text-successink"
      : sign === "all-negative"
        ? "bg-warntint text-warnink"
        : "bg-panel text-ink2";
  return { className: `${base} border border-line2`, style: { opacity: alpha } };
}

export function RequestsMatrix({
  rows,
  columns,
  people,
  historyCount,
  historyLabels,
  reqData,
  shiftTypeOrderIndex,
  mode,
  stagedKeys,
  onCellClick,
  onHistoryClick,
  onCellPointerDown,
  onCellPointerEnter,
  onHistoryPointerDown,
  onHistoryPointerEnter,
}: RequestsMatrixProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Pointer-aware geometry: dense 40px rows / 40px history columns on a precise
  // pointer (the prototype's metrics), growing to the 44px coarse minimum on
  // touch. Default is the precise value so SSR/first paint matches the server
  // render; a post-mount effect adopts the live media query, which has settled
  // before the route's readiness wait takes its measurements.
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    // jsdom (and SSR) has no matchMedia; the default precise geometry stays,
    // which is correct for both since neither is a coarse-pointer context.
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia("(pointer: coarse)");
    const update = () => setCoarse(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  const rowHeight = coarse ? ROW_HEIGHT_COARSE : ROW_HEIGHT;
  const historyColWidth = coarse ? HISTORY_COL_COARSE : HISTORY_COL_WIDTH;

  const peopleById = useMemo(() => {
    const map = new Map<string, UiPerson>();
    for (const p of people) map.set(String(p.id), p);
    return map;
  }, [people]);

  // Coordinate → cell membership, computed once per `reqData` change. Replaces a
  // per-cell `cellPreferenceSet` full scan (O(reqData) each) with an O(1)
  // `map.get(key)`, so the hot quick-paint/drag re-render path no longer runs a
  // people×days scan per visible cell.
  const cellsByCoord = useMemo(() => buildCellsByCoord(reqData), [reqData]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 8,
  });
  // estimateSize closes over `rowHeight`; when it changes (coarse-pointer
  // adoption) the per-index measurement cache is stale, so re-measure.
  useEffect(() => {
    virtualizer.measure();
  }, [rowHeight, virtualizer]);

  const gridTemplateColumns = useMemo(() => {
    const widths = [
      `${NURSE_COL_WIDTH}px`,
      ...Array.from({ length: historyCount }, () => `${historyColWidth}px`),
      ...columns.map((c) => `${columnWidth(c)}px`),
    ];
    return widths.join(" ");
  }, [historyCount, columns, historyColWidth]);

  if (rows.length === 0 || columns.length === 0) {
    return (
      <div
        className="border border-line bg-surface p-8 text-center text-sm text-ink3"
        data-testid="requests-matrix-empty"
      >
        No requests matrix to display yet.
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      tabIndex={0}
      aria-label="Requests matrix"
      className={cn(
        // The matrix is a specialized L1 surface: --surface tone + --sh-1, but
        // emphatically square. Generic card rounding must not leak into the
        // grid, its sticky header, its first column or its selection outline
        // (DESIGN.md §5 "Stay square, always"), so `rounded-none` is the
        // explicit data-surface treatment, not an absence.
        "relative max-h-[68vh] overflow-auto rounded-none border border-line bg-surface shadow-1 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-brand",
        mode === "quick" && "select-none",
      )}
      data-testid="requests-matrix"
    >
      <div style={{ minWidth: "max-content" }}>
        {/* Header row */}
        <div
          className="grid sticky top-0 z-20"
          style={{ gridTemplateColumns }}
          data-testid="requests-matrix-header"
        >
          <div
            className="sticky left-0 z-30 flex items-center border-b border-r border-line bg-panel px-3 py-2 text-label font-semibold uppercase tracking-[0.03em] text-ink2"
            style={{ height: HEADER_ROW_HEIGHT }}
          >
            Nurse
          </div>
          {historyLabels.map((label, i) => (
            <div
              key={`h-head-${i}`}
              className="flex items-center justify-center border-b border-r border-line2 bg-warntint font-mono text-label text-warnink"
              style={{ height: HEADER_ROW_HEIGHT }}
              title={label}
              data-testid={`hist-head-${i}`}
            >
              {label}
            </div>
          ))}
          {columns.map((col, i) => {
            const holiday = col.kind === "date-item" && isSingaporePublicHoliday(col.iso);
            const GroupIcon =
              col.kind === "date-group" ? dateGroupIcon(col.ref, col.synthetic) : null;
            return (
              <div
                key={`col-head-${i}`}
                className={cn(
                  "flex flex-col items-center justify-center gap-0.5 border-b border-r border-line2 px-1 text-center",
                  col.kind === "date-group"
                    ? "bg-brandtint"
                    : col.weekend
                      ? "bg-panel"
                      : "bg-surface",
                )}
                style={{
                  height: HEADER_ROW_HEIGHT,
                  ...(holiday ? { backgroundImage: HOLIDAY_STRIPE_BG } : null),
                }}
                title={col.kind === "date-group" ? (col.description ?? col.label) : col.label}
                data-testid={`col-head-${i}`}
              >
                {GroupIcon ? <GroupIcon className="size-2.5 text-brandink" aria-hidden /> : null}
                <span
                  className={cn(
                    "font-mono text-label",
                    col.kind === "date-group"
                      ? "font-bold text-brandink"
                      : holiday
                        ? "text-warn"
                        : "text-ink",
                  )}
                >
                  {col.label}
                </span>
                {col.kind === "date-group" && col.count !== undefined ? (
                  <span className="text-[9px] text-ink3">{col.count}</span>
                ) : null}
                {col.kind === "date-item" ? (
                  <span className="font-mono text-[9px] text-ink3">
                    {WEEKDAY_ABBR[utcDayOfWeek(col.iso)]}
                  </span>
                ) : null}
                {holiday ? (
                  <span
                    className="size-[5px] bg-warn"
                    data-testid={`col-head-${i}-holiday`}
                    aria-hidden
                  />
                ) : null}
              </div>
            );
          })}
        </div>

        {/* Body — virtualized rows */}
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index];
            const person = peopleById.get(String(row.id));
            return (
              <div
                key={row.isGroup ? `g:${row.id}` : `p:${row.id}`}
                className="grid absolute left-0 top-0 w-full"
                style={{
                  gridTemplateColumns,
                  transform: `translateY(${virtualRow.start}px)`,
                  height: virtualRow.size,
                }}
                data-testid={`row-${row.id}`}
              >
                <div
                  className="sticky left-0 z-10 flex items-center gap-2 truncate border-b border-r border-line bg-surface px-3"
                  title={row.description}
                >
                  <span className="truncate text-sm font-medium text-ink">{row.label}</span>
                  {row.isGroup ? (
                    <span className="font-mono text-[10px] text-brandink">GROUP</span>
                  ) : null}
                </div>

                {Array.from({ length: historyCount }, (_, columnIndex) => {
                  if (row.isGroup || !person) {
                    return (
                      <div
                        key={`hist-${columnIndex}`}
                        className="flex items-center justify-center border-b border-r border-line2 text-ink3"
                        data-testid={`hist-${row.id}-${columnIndex}`}
                      >
                        —
                      </div>
                    );
                  }
                  const value = historyValueAt(person, columnIndex, historyCount);
                  const clickable = isHistorySlotClickable(person, columnIndex, historyCount);
                  // Prototype `showPlus`: an empty, clickable slot in normal mode gets a
                  // faint "+" add affordance (ScreenRequests.dc.html:553-555); quick mode
                  // never shows it since a click there doesn't open the history editor.
                  const showPlus = !value && clickable && mode === "normal";
                  // Only a clickable slot in NORMAL mode opens an editor, so only
                  // that slot becomes a keyboard control. Quick-paint slots are
                  // drag targets and non-clickable padding is inert — giving
                  // either one button semantics would advertise an action that
                  // does not exist.
                  const historyActionable = clickable && mode === "normal";
                  // Identical presentation for both element types: the geometry
                  // lives entirely in these classes, so a native button and a div
                  // render the same box.
                  const historyPresentation = {
                    className: cn(
                      "flex items-center justify-center border-b border-r border-line2 font-mono text-label",
                      clickable
                        ? cn("cursor-pointer hover:bg-panel", showPlus ? "text-faint" : "text-ink2")
                        : "text-faint",
                    ),
                    "data-testid": `hist-${row.id}-${columnIndex}`,
                  };
                  const historyContent = value ?? (showPlus ? "+" : "");

                  // Only a clickable slot in NORMAL mode opens an editor, so only
                  // that slot is a real control. Quick-paint slots are drag
                  // targets and non-clickable padding is inert — giving either one
                  // button semantics would advertise an action that does not exist.
                  if (historyActionable) {
                    return (
                      <button
                        key={`hist-${columnIndex}`}
                        type="button"
                        {...historyPresentation}
                        aria-label={`Edit history ${historyLabels[columnIndex] ?? `slot ${columnIndex + 1}`} for ${row.label}${value ? `, currently ${value}` : ", currently empty"}`}
                        onClick={(event: MouseEvent<HTMLButtonElement>) =>
                          onHistoryClick(row.id, columnIndex, event.currentTarget)
                        }
                      >
                        {historyContent}
                      </button>
                    );
                  }
                  return (
                    <div
                      key={`hist-${columnIndex}`}
                      {...historyPresentation}
                      {...(clickable
                        ? {
                            onPointerDown: () => onHistoryPointerDown(row.id, columnIndex),
                            onPointerEnter: () => onHistoryPointerEnter(row.id, columnIndex),
                          }
                        : {})}
                    >
                      {historyContent}
                    </div>
                  );
                })}

                {columns.map((col, colIdx) => {
                  const colRef = col.ref;
                  const key = coordKey(row.id, colRef);
                  const cellsAt = cellsByCoord.get(key) ?? EMPTY_CELLS;
                  const view = buildCellView(cellsAt, shiftTypeOrderIndex);
                  const staged = stagedKeys?.has(key) ?? false;
                  const visual = cellVisual(view, cellsAt);
                  // Identical presentation for both element types — see the
                  // history slot above.
                  const cellPresentation = {
                    className: cn(
                      "flex items-center justify-center overflow-hidden border-b border-r px-1 text-center text-[10px] leading-tight cursor-pointer",
                      visual.className,
                      col.kind === "date-item" && col.weekend && view.empty ? "bg-panel" : null,
                      staged ? "outline outline-2 outline-brand -outline-offset-2" : null,
                    ),
                    style: visual.style,
                    title: view.primaryText || undefined,
                    "data-testid": `cell-${row.id}-${colRef}`,
                  };
                  const cellContent = view.empty ? null : (
                    <span className="truncate">
                      {view.primaryText}
                      {view.shadowedCount > 0 ? (
                        <span className="text-faint"> (+{view.shadowedCount})</span>
                      ) : null}
                    </span>
                  );

                  // Normal mode opens the cell editor, so the cell is a real
                  // control; quick-paint cells are drag targets and never become
                  // false buttons.
                  if (mode === "normal") {
                    return (
                      <button
                        key={`cell-${colIdx}`}
                        type="button"
                        {...cellPresentation}
                        aria-label={`Edit ${row.label} on ${col.label}${
                          view.primaryText ? `, currently ${view.primaryText}` : ", no request"
                        }`}
                        onClick={(event: MouseEvent<HTMLButtonElement>) =>
                          onCellClick(row.id, colRef, event.currentTarget)
                        }
                      >
                        {cellContent}
                      </button>
                    );
                  }
                  return (
                    <div
                      key={`cell-${colIdx}`}
                      {...cellPresentation}
                      onPointerDown={() => onCellPointerDown(row.id, colRef)}
                      onPointerEnter={() => onCellPointerEnter(row.id, colRef)}
                    >
                      {cellContent}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
