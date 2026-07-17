"use client";

// Multi-month grid host (T10; spec 02 FR-DC-17). The roster range may span several
// months, and the Dates UI renders ONE month grid per spanned month — both the
// read-only calendar overview (`./calendar-view`) and the shared date-scope picker
// (`./date-scope-picker`) build on this. It maps each first-of-month ISO from
// `spannedMonths` to a `MonthCalendar`, rendering a visible month heading above
// each grid (audit MAJOR 4) and forwarding the class/content/click surface so both
// consumers stay visually consistent.

import type { ReactNode } from "react";
import { useMemo } from "react";
import { spannedMonths, type DateRange } from "@/lib/dates";
import { MonthCalendar, type DayCellInfo } from "./month-calendar";

const MONTH_LABEL = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

export interface MonthGridsProps {
  /** The committed roster range whose months are rendered. */
  range: DateRange;
  /** Calendar variant forwarded to every `MonthCalendar`. */
  variant?: "display" | "picker";
  /** Show the per-grid month heading: `true` always, `"multi"` only when >1 month. */
  monthLabels?: boolean | "multi";
  /** Design-token utility classes for a day cell. */
  dayClassNames?: (info: DayCellInfo) => string[];
  /** Custom cell content (number + endpoint label + holiday marker). */
  dayContent?: (info: DayCellInfo) => ReactNode;
  /** Native tooltip + accessible label for a day cell (e.g. the holiday name). */
  dayTitle?: (info: DayCellInfo) => string | undefined;
  /** Click handler for a day cell, receiving its ISO `YYYY-MM-DD`. */
  onDayClick?: (iso: string) => void;
}

/** Human month label for a first-of-month ISO key, e.g. `July 2026`. */
function monthLabel(monthIso: string): string {
  // `monthIso` is a UTC midnight; format its UTC fields so the label is stable.
  return MONTH_LABEL.format(new Date(`${monthIso}T00:00:00Z`));
}

export function MonthGrids({
  range,
  variant = "display",
  monthLabels = "multi",
  dayClassNames,
  dayContent,
  dayTitle,
  onDayClick,
}: MonthGridsProps) {
  const months = useMemo(() => spannedMonths(range), [range]);
  if (months.length === 0) return null;

  const showLabel = monthLabels === true || (monthLabels === "multi" && months.length > 1);

  return (
    <div className="flex flex-col gap-4" data-testid="month-grids">
      {months.map((monthIso, index) => (
        // Key includes the range endpoints so a cell's mount-time attributes (the
        // holiday/endpoint `title`/`aria-label` set in `dayCellDidMount`) are
        // recomputed on ANY range change — even one that keeps the same month and
        // would otherwise NOT remount the grid, leaving a stale endpoint title.
        <div key={`${monthIso}:${range.start}:${range.end}`}>
          {showLabel ? (
            <div
              className="mb-2 font-mono text-label font-semibold uppercase tracking-[0.04em] text-ink2"
              data-testid={`month-label-${monthIso}`}
            >
              {monthLabel(monthIso)}
            </div>
          ) : null}
          <MonthCalendar
            monthIso={monthIso}
            variant={variant}
            dayClassNames={dayClassNames}
            dayContent={dayContent}
            dayTitle={dayTitle}
            onDayClick={onDayClick}
            ariaLabel={`${monthLabel(monthIso)}${months.length > 1 ? ` (month ${index + 1} of ${months.length})` : ""}`}
          />
        </div>
      ))}
    </div>
  );
}
