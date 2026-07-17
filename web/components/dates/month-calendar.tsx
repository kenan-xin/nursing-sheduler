"use client";

// A single-month FullCalendar grid (T10; spec 02 FR-DC-17). One instance is
// rendered per spanned month (`./month-grids`, used by the calendar overview and
// the shared date-scope picker). This is the ONLY place FullCalendar is touched.
//
// Two variants share this one wrapper (prototype fidelity: audit MAJOR 4 + MINOR 2):
//   • "display" — the read-only roster overview: Monday-first, adjacent months
//     rendered muted (`showNonCurrentDates`), in-range brand band, solid labelled
//     endpoints, compact holiday marker.
//   • "picker"  — the compact group day-scope editor: Monday-first, adjacent
//     months hidden, out-of-range days muted/disabled, solid selected cells.
//
// FullCalendar builds its DOM imperatively after mount, so the server render is an
// empty container and hydration matches. Cells are Monday-first (`firstDay={1}`,
// https://fullcalendar.io/docs/firstDay) and every cell is addressed via UTC
// `data-ns-date`. Cell classes/content come from the caller through the day-cell
// render hooks (https://fullcalendar.io/docs/day-cell-render-hooks).

import type { ReactNode } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";

/** Everything a caller needs to class/label one day cell. */
export interface DayCellInfo {
  /** UTC `YYYY-MM-DD` of the cell. */
  iso: string;
  /** UTC day of week (0 = Sunday … 6 = Saturday). */
  utcDay: number;
  /** FullCalendar's day-of-month text, e.g. `1`. */
  dayText: string;
  /** True for an adjacent-month day (only rendered in the "display" variant). */
  isOther: boolean;
}

export interface MonthCalendarProps {
  /** First-of-month ISO `YYYY-MM-01` the grid is fixed to. */
  monthIso: string;
  /** "display" shows adjacent months muted; "picker" hides them. */
  variant?: "display" | "picker";
  /** Design-token utility classes for a day cell. */
  dayClassNames?: (info: DayCellInfo) => string[];
  /** Custom cell content (number + endpoint label + holiday marker). */
  dayContent?: (info: DayCellInfo) => ReactNode;
  /** Native tooltip + accessible label for a day cell (e.g. the holiday name). */
  dayTitle?: (info: DayCellInfo) => string | undefined;
  /** Click handler for a day cell, receiving its ISO `YYYY-MM-DD`. */
  onDayClick?: (iso: string) => void;
  /** Accessible label for the grid region. */
  ariaLabel?: string;
}

/** ISO `YYYY-MM-DD` of a FullCalendar marker date (its UTC fields are the day). */
function markerIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function MonthCalendar({
  monthIso,
  variant = "display",
  dayClassNames,
  dayContent,
  dayTitle,
  onDayClick,
  ariaLabel,
}: MonthCalendarProps) {
  const info = (date: Date, dayText: string, isOther: boolean): DayCellInfo => ({
    iso: markerIso(date),
    utcDay: date.getUTCDay(),
    dayText,
    isOther,
  });

  return (
    <div
      className={`ns-month-calendar ns-month-calendar--${variant}`}
      role="group"
      aria-label={ariaLabel}
    >
      <FullCalendar
        plugins={[dayGridPlugin, interactionPlugin]}
        initialView="dayGridMonth"
        initialDate={monthIso}
        timeZone="UTC"
        headerToolbar={false}
        fixedWeekCount={false}
        showNonCurrentDates={variant === "display"}
        height="auto"
        firstDay={1}
        dayMaxEvents={false}
        dayCellClassNames={(arg) =>
          dayClassNames?.(info(arg.date, arg.dayNumberText, arg.isOther)) ?? []
        }
        dayCellContent={
          dayContent
            ? (arg) => dayContent(info(arg.date, arg.dayNumberText, arg.isOther))
            : undefined
        }
        dayCellDidMount={(arg) => {
          arg.el.dataset.nsDate = markerIso(arg.date);
          // Surface the holiday name (or endpoint/holiday title) as the cell's
          // native tooltip + accessible label — stable per date, so mount-time is
          // enough (holiday names never change while a month grid is mounted).
          const title = dayTitle?.(info(arg.date, arg.dayNumberText, arg.isOther));
          if (title) {
            arg.el.title = title;
            arg.el.setAttribute("aria-label", title);
          }
        }}
        dateClick={onDayClick ? (arg) => onDayClick(markerIso(arg.date)) : undefined}
      />
    </div>
  );
}
