"use client";

// Read-only roster calendar card (T10; spec 02 FR-DC-17/18 / acceptance row 5).
// Renders the prototype's calendar card (ScreenDates lines 82-126): a header with
// the month identity + the exact three-item legend, then one Monday-first month
// grid per spanned month. Ordinary in-range days carry a brand-tint band, the two
// endpoints are solid and labelled START / END, Singapore public holidays get a
// compact corner marker, and out-of-range / adjacent-month days render muted.

import { useMemo } from "react";
import {
  getSingaporePublicHolidayName,
  isSingaporePublicHoliday,
  type DateRange,
} from "@/lib/dates";
import { FaCalendarDays } from "@/components/icons";
import { MonthGrids } from "./month-grids";
import type { DayCellInfo } from "./month-calendar";
import { rangeSpanLabel } from "./range-span-label";

export function CalendarView({ range }: { range: DateRange }) {
  const headerLabel = useMemo(() => rangeSpanLabel(range), [range]);

  const inRange = (iso: string) => iso >= range.start && iso <= range.end;

  const dayClassNames = (info: DayCellInfo): string[] => {
    if (info.isOther || !inRange(info.iso)) return ["ns-cal-outside"];
    const isEndpoint = info.iso === range.start || info.iso === range.end;
    const classes = ["ns-cal-in"];
    // Endpoints are solid brand and take precedence — the prototype checks endpoints
    // BEFORE holiday/weekend styling (ScreenDates 328-346), so an endpoint that is
    // also a holiday/weekend does NOT get those classes (MINOR 1); the holiday is
    // still surfaced via the corner marker + title below.
    if (info.iso === range.start) classes.push("ns-cal-start");
    if (info.iso === range.end) classes.push("ns-cal-end");
    if (!isEndpoint) {
      if (info.utcDay === 0 || info.utcDay === 6) classes.push("ns-cal-weekend");
      if (isSingaporePublicHoliday(info.iso)) classes.push("ns-cal-holiday");
    }
    return classes;
  };

  const dayContent = (info: DayCellInfo) => {
    // Spillover (adjacent-month) cells are muted and NEVER labelled, even when their
    // ISO equals an endpoint of a neighbouring grid (MINOR 4).
    const isStart = !info.isOther && info.iso === range.start;
    const isEnd = !info.isOther && info.iso === range.end;
    const holiday = inRange(info.iso) && !info.isOther && isSingaporePublicHoliday(info.iso);
    return (
      <>
        <span className="ns-cal-num">{info.dayText}</span>
        {isStart || isEnd ? (
          <span className="ns-cal-endlabel">{isStart ? "START" : "END"}</span>
        ) : null}
        {holiday ? <span className="ns-cal-holiday-dot" aria-hidden /> : null}
      </>
    );
  };

  // Cell tooltip / accessible label: the holiday name is ALWAYS surfaced for a
  // holiday cell — including an endpoint that is also a holiday (whose styling drops
  // the holiday class) — combined with the endpoint role, matching the prototype's
  // `Start/End of roster · <holiday>` title (ScreenDates 328-346).
  const dayTitle = (info: DayCellInfo): string | undefined => {
    if (info.isOther || !inRange(info.iso)) return undefined;
    const endpoint =
      info.iso === range.start ? "Start of roster" : info.iso === range.end ? "End of roster" : "";
    const holidayName = isSingaporePublicHoliday(info.iso)
      ? getSingaporePublicHolidayName(info.iso)
      : null;
    if (endpoint && holidayName) return `${endpoint} · ${holidayName}`;
    return endpoint || holidayName || undefined;
  };

  return (
    <section className="border border-line bg-surface" data-testid="calendar-view">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line2 px-[18px] py-4">
        <div className="flex min-w-0 items-center gap-2">
          <FaCalendarDays className="size-3.5 text-ink3" />
          <h2 className="font-heading text-cardhead font-extrabold tracking-tight">
            {headerLabel}
          </h2>
        </div>
        <Legend />
      </div>
      <div className="p-[14px]">
        <MonthGrids
          range={range}
          variant="display"
          monthLabels="multi"
          dayClassNames={dayClassNames}
          dayContent={dayContent}
          dayTitle={dayTitle}
        />
      </div>
    </section>
  );
}

/** The prototype's exact three-item legend: In roster / Start · end / Holiday. */
function Legend() {
  return (
    <ul className="flex flex-wrap items-center gap-3.5 text-meta text-ink2">
      <li className="flex items-center gap-1.5">
        <span className="ns-legend ns-legend--inrange" aria-hidden /> In roster
      </li>
      <li className="flex items-center gap-1.5">
        <span className="ns-legend ns-legend--endpoint" aria-hidden /> Start / end
      </li>
      <li className="flex items-center gap-1.5">
        <span className="ns-legend ns-legend--holiday" aria-hidden /> Holiday
      </li>
    </ul>
  );
}
