"use client";

// Shift Requests matrix (T11; spec 04 FR-SR-03..16, prototype ScreenRequests.dc.html
// lines ~89-128). Presentational + gesture-callback-driven: rows/columns/data come in
// as props, cell/history clicks and quick-paint pointer events go out as callbacks. The
// container owns the store wiring, staged-drag state, and the global pointer-up that
// commits a gesture. Row-virtualized (~100 people) via `@tanstack/react-virtual`; the
// bounded column set (history + date-group + date-item) renders fully per column, so
// the sticky Nurse column and sticky header stay simple `position: sticky` cells.

import { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { DateRef, PersonRef, UiPerson, UiRequestCell } from "@/lib/scenario";
import {
  aggregateSign,
  cellAlpha,
  cellDisplay,
  cellPreferenceOf,
  cellPreferenceSet,
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
  onCellClick(person: PersonRef, colRef: DateRef): void;
  onHistoryClick(person: PersonRef, columnIndex: number): void;
  onCellPointerDown(person: PersonRef, colRef: DateRef): void;
  onCellPointerEnter(person: PersonRef, colRef: DateRef): void;
  onHistoryPointerDown(person: PersonRef, columnIndex: number): void;
  onHistoryPointerEnter(person: PersonRef, columnIndex: number): void;
}

const ROW_HEIGHT = 40;
/** Header row is taller than a body row (ROW_HEIGHT) to fit the date-group icon +
 *  count, and the date-item weekday sub-label + holiday dot (prototype
 *  ScreenRequests.dc.html:98-102). */
const HEADER_ROW_HEIGHT = 52;
const NURSE_COL_WIDTH = 176;
const HISTORY_COL_WIDTH = 40;
const DATE_GROUP_COL_WIDTH = 76;
const DATE_ITEM_COL_WIDTH = 56;

const WEEKDAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Prototype's holiday header stripe (ScreenRequests.dc.html `HOLIDAY_BG`). */
const HOLIDAY_STRIPE_BG =
  "repeating-linear-gradient(135deg, var(--warntint) 0px, var(--warntint) 3px, var(--surface) 3px, var(--surface) 9px)";

function columnWidth(column: RequestColumn): number {
  return column.kind === "date-group" ? DATE_GROUP_COL_WIDTH : DATE_ITEM_COL_WIDTH;
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
    return { className: "bg-brandtint text-brandink border border-brand" };
  if (view.dayState === "off") return { className: "bg-errortint text-error border border-error" };
  const prefs = cellsAt.map(cellPreferenceOf);
  const sign = aggregateSign(prefs);
  const alpha = cellAlpha(prefs);
  const base =
    sign === "all-positive"
      ? "bg-successtint text-success"
      : sign === "all-negative"
        ? "bg-warntint text-warn"
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
  const peopleById = useMemo(() => {
    const map = new Map<string, UiPerson>();
    for (const p of people) map.set(String(p.id), p);
    return map;
  }, [people]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  const gridTemplateColumns = useMemo(() => {
    const widths = [
      `${NURSE_COL_WIDTH}px`,
      ...Array.from({ length: historyCount }, () => `${HISTORY_COL_WIDTH}px`),
      ...columns.map((c) => `${columnWidth(c)}px`),
    ];
    return widths.join(" ");
  }, [historyCount, columns]);

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
      className={cn(
        "relative max-h-[68vh] overflow-auto border border-line bg-surface",
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
              className="flex items-center justify-center border-b border-r border-line2 bg-warntint font-mono text-label text-ink2"
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
                  const handlers = !clickable
                    ? {}
                    : mode === "normal"
                      ? { onClick: () => onHistoryClick(row.id, columnIndex) }
                      : {
                          onPointerDown: () => onHistoryPointerDown(row.id, columnIndex),
                          onPointerEnter: () => onHistoryPointerEnter(row.id, columnIndex),
                        };
                  return (
                    <div
                      key={`hist-${columnIndex}`}
                      className={cn(
                        "flex items-center justify-center border-b border-r border-line2 font-mono text-label",
                        clickable
                          ? cn(
                              "cursor-pointer hover:bg-panel",
                              showPlus ? "text-faint" : "text-ink2",
                            )
                          : "text-faint",
                      )}
                      data-testid={`hist-${row.id}-${columnIndex}`}
                      {...handlers}
                    >
                      {value ?? (showPlus ? "+" : "")}
                    </div>
                  );
                })}

                {columns.map((col, colIdx) => {
                  const colRef = col.ref;
                  const cellsAt = cellPreferenceSet(reqData, row.id, colRef);
                  const view = buildCellView(cellsAt, shiftTypeOrderIndex);
                  const key = JSON.stringify([row.id, colRef]);
                  const staged = stagedKeys?.has(key) ?? false;
                  const handlers =
                    mode === "normal"
                      ? { onClick: () => onCellClick(row.id, colRef) }
                      : {
                          onPointerDown: () => onCellPointerDown(row.id, colRef),
                          onPointerEnter: () => onCellPointerEnter(row.id, colRef),
                        };
                  const visual = cellVisual(view, cellsAt);
                  return (
                    <div
                      key={`cell-${colIdx}`}
                      className={cn(
                        "flex items-center justify-center overflow-hidden border-b border-r px-1 text-center text-[10px] leading-tight cursor-pointer",
                        visual.className,
                        col.kind === "date-item" && col.weekend && view.empty ? "bg-panel" : null,
                        staged ? "outline outline-2 outline-brand -outline-offset-2" : null,
                      )}
                      style={visual.style}
                      title={view.primaryText || undefined}
                      data-testid={`cell-${row.id}-${colRef}`}
                      {...handlers}
                    >
                      {view.empty ? null : (
                        <span className="truncate">
                          {view.primaryText}
                          {view.shadowedCount > 0 ? (
                            <span className="text-faint"> (+{view.shadowedCount})</span>
                          ) : null}
                        </span>
                      )}
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
