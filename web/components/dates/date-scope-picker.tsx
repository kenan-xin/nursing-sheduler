"use client";

// Shared date-scope picker (T10 primitive; first consumer = the date-group editor,
// next consumer = T13 covering date-scope). A compact inline calendar for choosing
// a set of IN-RANGE days: quick-picks (Weekends / Weekdays / Clear) plus one
// month grid per spanned month with solid selected cells and muted, non-clickable
// out-of-range days (audit MAJOR 5 + MINOR 2 + Nit; prototype ScreenDates lines
// 169-198).
//
// FULLY CONTROLLED: it holds no state. `selected` is the set of selected in-range
// ISO dates and every change is reported through `onChange` with the complete new
// set — the owner maps ISO⇄date-id and merges any out-of-range members it wants to
// preserve (the date-group editor preserves them per spec 02 FR-DC-44). Quick-picks
// only ever produce in-range ISO, so an owner that merges preserved members keeps
// them across a quick-pick, unlike the prototype which drops them (spec wins).

import { useMemo } from "react";
import {
  generateDateItems,
  isSingaporePublicHoliday,
  utcDayOfWeek,
  type DateRange,
} from "@/lib/dates";
import { MonthGrids } from "./month-grids";
import type { DayCellInfo } from "./month-calendar";

export interface DateScopePickerProps {
  /** The committed roster range (defines the selectable in-range day set). */
  range: DateRange;
  /** Currently selected in-range ISO `YYYY-MM-DD` dates. */
  selected: ReadonlySet<string>;
  /** Report the complete new set of selected in-range ISO dates. */
  onChange: (selectedIso: string[]) => void;
  /** Section label above the grids (default "PICK DAYS"). */
  label?: string;
  /** Test id for the picker root (defaults to `date-scope-picker`). */
  testId?: string;
}

function isWeekend(utcDay: number): boolean {
  return utcDay === 0 || utcDay === 6;
}

export function DateScopePicker({
  range,
  selected,
  onChange,
  label = "Pick days",
  testId = "date-scope-picker",
}: DateScopePickerProps) {
  const items = useMemo(() => generateDateItems(range), [range]);
  const weekdayIso = useMemo(
    () => items.filter((i) => !isWeekend(utcDayOfWeek(i.iso))).map((i) => i.iso),
    [items],
  );
  const weekendIso = useMemo(
    () => items.filter((i) => isWeekend(utcDayOfWeek(i.iso))).map((i) => i.iso),
    [items],
  );

  const inRange = (iso: string) => iso >= range.start && iso <= range.end;

  const handleDayClick = (iso: string) => {
    if (!inRange(iso)) return; // out-of-range days are not selectable
    const next = new Set(selected);
    if (next.has(iso)) next.delete(iso);
    else next.add(iso);
    onChange([...next]);
  };

  const dayClassNames = (info: DayCellInfo): string[] => {
    if (!inRange(info.iso)) return ["ns-pick-out"];
    const classes = ["ns-pick"];
    if (selected.has(info.iso)) classes.push("ns-pick-selected");
    if (isWeekend(info.utcDay)) classes.push("ns-pick-weekend");
    if (isSingaporePublicHoliday(info.iso)) classes.push("ns-pick-holiday");
    return classes;
  };

  const dayContent = (info: DayCellInfo) => <span className="ns-cal-num">{info.dayText}</span>;

  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-label font-semibold uppercase tracking-[0.03em] text-ink2">
          {label}
        </span>
        <span className="font-mono text-label text-ink3" data-testid={`${testId}-count`}>
          {selected.size} SELECTED
        </span>
        <span className="flex-1" />
        <button
          type="button"
          className="ns-quick-pick"
          data-testid={`${testId}-weekends`}
          onClick={() => onChange(weekendIso)}
        >
          Weekends
        </button>
        <button
          type="button"
          className="ns-quick-pick"
          data-testid={`${testId}-weekdays`}
          onClick={() => onChange(weekdayIso)}
        >
          Weekdays
        </button>
        <button
          type="button"
          className="ns-quick-pick ns-quick-pick--muted"
          data-testid={`${testId}-clear`}
          onClick={() => onChange([])}
        >
          Clear
        </button>
      </div>

      <div className="ns-scope-grids">
        <MonthGrids
          range={range}
          variant="picker"
          monthLabels
          dayClassNames={dayClassNames}
          dayContent={dayContent}
          onDayClick={handleDayClick}
        />
      </div>
    </div>
  );
}
