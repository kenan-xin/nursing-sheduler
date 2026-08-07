"use client";

// Roster Day lens (F4) — read-only.
//
// A single day chosen from a date strip (each date carries a health dot: fully
// staffed / at-minimum / under). Shows one panel per shift with who is on, and
// an off/leave list below. The initially-selected day is today if it falls
// within the roster's range, otherwise the first day.
//
// Mobile-native ("who's on today"), and the default lens on small screens.

import { useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { typedIdKey } from "@/lib/roster";
import type { RosterContext, RosterContextPerson, RosterDayGrid } from "@/lib/roster";
import { dateLabel, dayHealth, type CoverageGrid, type ShiftRampEntry } from "@/lib/roster-viewer";

export interface RosterDayProps {
  context: RosterContext;
  currentDays: RosterDayGrid;
  ramp: Map<string, ShiftRampEntry>;
  coverage: CoverageGrid;
  /** The focused day index. */
  focusedDay: number;
  /** Select a new focused day. */
  onFocusDay: (dateIdx: number) => void;
}

export function RosterDay({
  context,
  currentDays,
  ramp,
  coverage,
  focusedDay,
  onFocusDay,
}: RosterDayProps) {
  const calendar = context.calendar;
  const shiftTypes = context.shiftTypes;
  const safeFocused = Math.min(focusedDay, Math.max(0, calendar.length - 1));
  const day = calendar[safeFocused];
  const stripRef = useRef<HTMLDivElement | null>(null);

  /**
   * The tab keyboard model (WAI-ARIA tabs pattern). A `role="tablist"` promises
   * one tab stop plus arrow navigation; declaring the role without it leaves a
   * keyboard user tabbing through every date individually while assistive tech
   * announces a control that does not behave as announced.
   */
  const onStripKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const last = calendar.length - 1;
      if (last < 0) return;
      let next: number;
      switch (event.key) {
        case "ArrowRight":
        case "ArrowDown":
          next = safeFocused >= last ? 0 : safeFocused + 1;
          break;
        case "ArrowLeft":
        case "ArrowUp":
          next = safeFocused <= 0 ? last : safeFocused - 1;
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = last;
          break;
        default:
          return;
      }
      event.preventDefault();
      onFocusDay(next);
      // Selection follows focus, so move real DOM focus with it — otherwise the
      // next arrow key would be handled relative to a tab the user cannot see.
      const tabs = stripRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
      tabs?.[next]?.focus();
    },
    [calendar.length, onFocusDay, safeFocused],
  );

  return (
    <div data-testid="roster-day" className="rounded-card border border-line bg-surface p-4">
      {/* Date strip with health dots. */}
      <div
        ref={stripRef}
        className="flex gap-1.5 overflow-x-auto border-b border-line2 pb-3.5"
        role="tablist"
        aria-label="Select day"
        onKeyDown={onStripKeyDown}
      >
        {calendar.map((calDay, dateIdx) => {
          const health = dayHealth(coverage[dateIdx]);
          // `unknown` must NOT paint the healthy colour: nothing on this day was
          // checkable, so a green dot would assert staffing the predicate never
          // evaluated. It reads as a neutral hollow marker instead.
          const dotColor =
            health === "under"
              ? "bg-error"
              : health === "at"
                ? "bg-warn"
                : health === "unknown"
                  ? "border border-line bg-transparent"
                  : "bg-success";
          const healthLabel =
            health === "under"
              ? "under minimum"
              : health === "at"
                ? "at minimum"
                : health === "unknown"
                  ? "coverage unavailable"
                  : "staffed";
          const selected = dateIdx === safeFocused;
          return (
            <button
              key={calDay.iso}
              type="button"
              role="tab"
              aria-selected={selected}
              // Roving tabindex: the strip is ONE tab stop.
              tabIndex={selected ? 0 : -1}
              aria-label={`${dateLabel(calendar, dateIdx)} ${calDay.weekday} — ${healthLabel}`}
              title={`${dateLabel(calendar, dateIdx)} · ${healthLabel}`}
              onClick={() => onFocusDay(dateIdx)}
              className={cn(
                "flex w-[50px] shrink-0 cursor-pointer flex-col items-center border px-0 py-2 text-center",
                selected
                  ? "border-brand bg-brand text-onbrand"
                  : "border-line2 bg-surface text-ink",
                calDay.weekend && !selected && "bg-panel",
              )}
            >
              <span className="font-mono text-label-md font-bold">
                {dateLabel(calendar, dateIdx)}
              </span>
              <span
                className={cn(
                  "font-mono text-label",
                  selected ? "opacity-70" : "opacity-70 text-ink3",
                )}
              >
                {calDay.weekday}
              </span>
              {/* Colour is not the only carrier of this state: the dot's meaning
                  is in the tab's accessible name and its title. */}
              <span
                className={cn("mt-1 block size-1.5 rounded-full", dotColor)}
                aria-hidden
                data-health={health}
              />
            </button>
          );
        })}
      </div>

      {/* Day title. */}
      <h3 className="mb-3.5 mt-3.5 font-heading text-title font-semibold tracking-[-0.01em] text-ink">
        {day ? `${dateLabel(calendar, safeFocused)} · ${day.weekday}` : ""}
      </h3>

      {/* One panel per shift. */}
      <div className="flex flex-wrap items-stretch gap-3.5">
        {shiftTypes.map((shift, shiftIdx) => {
          const minimum = context.baselineMinimums[shiftIdx];
          const cell = coverage[safeFocused]?.shifts[shiftIdx];
          const assigned = peopleOnShift(currentDays, safeFocused, typedIdKey(shift.id), context);
          const short = cell !== undefined && cell.status === "available" && cell.short;
          const rampEntry = ramp.get(typedIdKey(shift.id));
          const needLabel = "unavailable" in minimum ? "unavailable" : `min ${minimum.required}`;
          return (
            <div
              key={typedIdKey(shift.id)}
              className={cn(
                "min-w-[220px] flex-1 border p-3",
                short ? "border-error bg-errortint" : "border-line2 bg-panel",
              )}
            >
              <div className="mb-3 flex items-center justify-between gap-2.5">
                <div className="flex items-center gap-2">
                  <span
                    className="size-3 shrink-0 rounded-[3px]"
                    style={{ backgroundColor: rampEntry?.bar ?? "var(--line)" }}
                    aria-hidden
                  />
                  <div>
                    <div className="font-heading text-body font-bold text-ink">
                      {String(shift.id)}
                    </div>
                    <div className="font-mono text-label font-medium text-ink3">{needLabel}</div>
                  </div>
                </div>
                <div className="text-right">
                  {cell !== undefined && cell.status === "available" ? (
                    <span
                      className={cn(
                        "font-mono text-title font-bold",
                        short ? "text-errorink" : "text-ink",
                      )}
                    >
                      {cell.staffed}
                      <span className="font-medium text-ink3">/{cell.required}</span>
                    </span>
                  ) : null}
                  {short ? (
                    <div className="font-ui text-label font-bold uppercase tracking-[0.04em] text-errorink">
                      Short
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="flex flex-col gap-2">
                {assigned.map((person) => (
                  <div
                    key={typedIdKey(person.id)}
                    className="flex items-center gap-2 border border-line2 bg-surface px-2 py-1.5"
                  >
                    <span className="inline-flex size-[30px] shrink-0 items-center justify-center rounded-[50%] border border-line2 bg-panel font-mono text-label font-bold text-ink2">
                      {initials(String(person.id))}
                    </span>
                    <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-meta font-semibold text-ink text-ellipsis">
                      {String(person.id)}
                    </span>
                    <span
                      className="rounded-chip px-2 py-0.5 font-mono text-label font-bold"
                      style={{
                        backgroundColor: rampEntry?.fill ?? "var(--panel)",
                        color: rampEntry?.ink ?? "var(--ink2)",
                      }}
                    >
                      {String(shift.id)}
                    </span>
                  </div>
                ))}
                {assigned.length === 0 ? (
                  <div className="px-0.5 py-1.5 text-meta font-medium text-ink3">
                    Nobody assigned
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {/* Off / leave list. */}
      <OffLeaveList context={context} currentDays={currentDays} dateIdx={safeFocused} />
    </div>
  );
}

function OffLeaveList({
  context,
  currentDays,
  dateIdx,
}: {
  context: RosterContext;
  currentDays: RosterDayGrid;
  dateIdx: number;
}) {
  const offPeople = context.people.filter((_, personIdx) => {
    const cell = currentDays[personIdx]?.[dateIdx];
    return cell !== undefined && (cell.kind === "off" || cell.kind === "leave");
  });

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2.5 border-t border-line2 pt-3.5">
      <span className="font-ui text-label font-semibold uppercase tracking-[0.04em] text-ink3">
        Off / leave
      </span>
      {offPeople.map((person) => {
        const personIdx = context.people.indexOf(person);
        const cell = currentDays[personIdx]?.[dateIdx];
        const isLeave = cell?.kind === "leave";
        return (
          <span
            key={typedIdKey(person.id)}
            className={cn(
              "inline-flex h-6 items-center rounded-pill px-2.5 font-mono text-label font-semibold",
              // Leave is NEUTRAL everywhere. Brand tint is the system's selection
              // language; spending it on a leave marker both misreads as selected
              // and contradicts the rule the ShiftChip already follows.
              isLeave ? "bg-panel text-ink2" : "bg-panel text-ink3",
            )}
          >
            {String(person.id)} · {isLeave ? "Leave" : "Off"}
          </span>
        );
      })}
      {offPeople.length === 0 ? (
        <span className="text-meta text-ink3">Everyone is on duty.</span>
      ) : null}
    </div>
  );
}

function peopleOnShift(
  grid: RosterDayGrid,
  dateIdx: number,
  shiftKey: string,
  context: RosterContext,
): RosterContextPerson[] {
  const result: RosterContextPerson[] = [];
  for (let personIdx = 0; personIdx < grid.length; personIdx++) {
    const cell = grid[personIdx][dateIdx];
    if (cell.kind === "shift" && typedIdKey(cell.shiftId) === shiftKey) {
      result.push(context.people[personIdx]);
    }
  }
  return result;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const second = parts[1]?.[0] ?? "";
  return (first + second).toUpperCase() || "?";
}
