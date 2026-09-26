"use client";

// Roster Day lens (F4, extended for G7) — read-only.
//
// One day chosen from a date strip, then the two planes that day actually has:
// the DECLARED requirements applicable to it, and the exact shifts with who is
// on them. The strip's health dot is the worst declared-equation verdict for the
// date — Short, Over, Unqualified or unavailable — so a group shortage turns the
// day red without any member shift inheriting a quota it was never given.
//
// Mobile-native ("who's on today"), and the default lens on small screens.

import { useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { typedIdKey } from "@/lib/roster";
import type { RosterContext, RosterDayGrid } from "@/lib/roster";
import {
  dateTitle,
  dayOfMonth,
  isNewMonth,
  monthLabel,
  requirementDayHealth,
  shiftContextLabel,
  shiftTimeRange,
  type CoverageGrid,
  type RequirementGrid,
  type RequirementModel,
  type ShiftRampEntry,
} from "@/lib/roster-viewer";

export interface RosterDayProps {
  context: RosterContext;
  /** The CURRENT assignments — the authority for the off/leave list. */
  currentDays: RosterDayGrid;
  ramp: Map<string, ShiftRampEntry>;
  /** The exact-shift plane. */
  coverage: CoverageGrid;
  /** The ephemeral equation definitions. */
  model: RequirementModel;
  /** `[equationIdx][dateIdx]` verdicts. */
  requirements: RequirementGrid;
  /** The focused day index. */
  focusedDay: number;
  /** Select a new focused day. */
  onFocusDay: (dateIdx: number) => void;
}

// `unknown` now covers BOTH "nothing on this day was evaluable" and "something
// applicable could not be evaluated", so its wording states the limit rather
// than the absence — a day with one satisfied and one unresolvable requirement
// has not been checked, and must not read as staffed.
const HEALTH_COPY = {
  under: "requirement not met",
  at: "at the stated minimum",
  ok: "staffed",
  unknown: "not fully checkable",
} as const;

export function RosterDay({
  context,
  currentDays,
  ramp,
  coverage,
  model,
  requirements,
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
        className="flex min-w-0 gap-1.5 overflow-x-auto border-b border-line2 pb-3.5"
        role="tablist"
        aria-label="Select day"
        onKeyDown={onStripKeyDown}
      >
        {calendar.map((calDay, dateIdx) => {
          const health = requirementDayHealth(requirements, dateIdx);
          // `unknown` must NOT paint the healthy colour: nothing on this day was
          // checkable, so a green dot would assert staffing nothing evaluated.
          const dotColor =
            health === "under"
              ? "bg-error"
              : health === "at"
                ? "bg-warn"
                : health === "unknown"
                  ? "border border-line bg-transparent"
                  : "bg-success";
          const selected = dateIdx === safeFocused;
          const showMonth = dateIdx === 0 || isNewMonth(calendar, dateIdx);
          return (
            <button
              key={calDay.iso}
              type="button"
              role="tab"
              aria-selected={selected}
              // Roving tabindex: the strip is ONE tab stop.
              tabIndex={selected ? 0 : -1}
              aria-label={`${dateTitle(calDay)} — ${HEALTH_COPY[health]}`}
              title={`${dateTitle(calDay)} · ${HEALTH_COPY[health]}`}
              onClick={() => onFocusDay(dateIdx)}
              className={cn(
                // Pill control grammar (DESIGN.md §5): the strip is a segmented
                // date control, not a data surface, so it rounds like a control.
                "flex w-[54px] shrink-0 cursor-pointer flex-col items-center rounded-pill border",
                "px-0 py-2 text-center transition-colors duration-fast",
                "pointer-coarse:min-h-touch",
                "focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-brand",
                selected
                  ? "border-brand bg-brand text-onbrand"
                  : "border-line2 bg-surface text-ink hover:bg-panel-alt",
                calDay.weekend && !selected && "bg-panel",
              )}
            >
              {/* Day-of-month leads; the weekday is the supporting line. A month
                  boundary states its month so a 28-day span never leaves the
                  reader guessing which one they are looking at. */}
              <span className="font-mono text-body font-bold leading-none">
                {dayOfMonth(calendar, dateIdx)}
              </span>
              <span
                className={cn(
                  "mt-0.5 font-ui text-label font-medium leading-none",
                  selected ? "opacity-80" : "text-ink3",
                )}
              >
                {calDay.weekday}
              </span>
              {showMonth ? (
                <span
                  className={cn(
                    "mt-0.5 font-ui text-label font-semibold uppercase leading-none tracking-[0.04em]",
                    selected ? "opacity-80" : "text-brandink",
                  )}
                >
                  {monthLabel(calendar, dateIdx)}
                </span>
              ) : null}
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
        {day ? dateTitle(day) : ""}
      </h3>

      {/* Declared requirements for THIS day, above the exact-shift panels. A
          group or qualified target lives here and only here — it is never
          inherited by a member shift's panel below. */}
      <section className="mb-4" data-testid="roster-day-requirements">
        <h4 className="mb-2 font-ui text-label font-semibold uppercase tracking-[0.04em] text-brandink">
          Declared requirements
        </h4>
        <div className="flex flex-wrap gap-2">
          {model.equations.map((equation, equationIdx) => {
            const cell = requirements[equationIdx]?.[safeFocused];
            if (cell === undefined || cell.status === "not-applicable") return null;
            const mismatch = cell.status === "checked" && cell.mismatch;
            const failures =
              cell.status === "checked"
                ? [
                    cell.short > 0 ? `Short ${cell.short}` : null,
                    cell.over > 0 ? `Over ${cell.over}` : null,
                    cell.unqualified > 0 ? `Unqualified ${cell.unqualified}` : null,
                    ...cell.mix
                      .filter((floor) => floor.short > 0)
                      .map((floor) => `${floor.label} short ${floor.short}`),
                  ].filter((label): label is string => label !== null)
                : [];
            return (
              <div
                key={equation.key}
                data-testid="roster-day-requirement"
                data-equation={equation.key}
                data-scope={equation.scopeLabel}
                data-mismatch={mismatch ? "true" : "false"}
                data-status={cell.status}
                title={equation.description ?? equation.scopeLabel}
                className={cn(
                  "flex min-w-[180px] flex-1 items-baseline justify-between gap-2 border px-3 py-2",
                  mismatch ? "border-error bg-errortint" : "border-line2 bg-panel",
                  cell.status === "unavailable" && "border-warn bg-warntint",
                )}
              >
                <div className="min-w-0">
                  <div className="font-mono text-meta font-bold text-ink">
                    {equation.scopeLabel}
                  </div>
                  {equation.qualifiedLabel !== null ? (
                    <div className="font-ui text-label text-ink3">
                      qualified: {equation.qualifiedLabel}
                    </div>
                  ) : null}
                </div>
                <div className="shrink-0 text-right">
                  {cell.status === "checked" ? (
                    <span
                      className={cn(
                        "font-mono text-body font-bold",
                        mismatch ? "text-errorink" : "text-ink",
                      )}
                    >
                      {cell.units}
                      <span className="font-medium text-ink3">/{cell.required}</span>
                    </span>
                  ) : (
                    <span className="font-mono text-label font-semibold text-warnink">
                      unavailable
                    </span>
                  )}
                  {failures.map((label) => (
                    <div
                      key={label}
                      data-testid="roster-day-mismatch"
                      className="font-ui text-label font-bold uppercase tracking-[0.04em] text-errorink"
                    >
                      {label}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
          {model.equations.length === 0 ? (
            <p className="text-meta text-ink3">
              {model.reason === null
                ? "This schedule states no staffing requirements."
                : `The staffing requirements could not be read from this roster (${model.reason}).`}
            </p>
          ) : null}
        </div>
      </section>

      {/* One panel per exact shift: who is on, and how many. */}
      <div className="flex flex-wrap items-stretch gap-3.5" data-testid="roster-day-shifts">
        {shiftTypes.map((shift, shiftIdx) => {
          const cell = coverage[safeFocused]?.shifts[shiftIdx];
          const people = cell?.people ?? [];
          const short = cell?.short === true;
          const rampEntry = ramp.get(typedIdKey(shift.id));
          const time = shiftTimeRange(shift);
          return (
            <div
              key={typedIdKey(shift.id)}
              data-testid="roster-day-shift-panel"
              data-shift={String(shift.id)}
              data-short={short ? "true" : "false"}
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
                  <div title={shiftContextLabel(shift)}>
                    <div className="font-heading text-body font-bold text-ink">
                      {String(shift.id)}
                    </div>
                    <div className="font-mono text-label font-medium text-ink3">
                      {time ?? String(shift.id)}
                      {cell?.required != null ? ` · min ${cell.required}` : ""}
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <span
                    className={cn(
                      "font-mono text-title font-bold",
                      short ? "text-errorink" : "text-ink",
                    )}
                  >
                    {people.length}
                    {cell?.required != null ? (
                      <span className="font-medium text-ink3">/{cell.required}</span>
                    ) : null}
                  </span>
                  {short ? (
                    <div className="font-ui text-label font-bold uppercase tracking-[0.04em] text-errorink">
                      Short
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="flex flex-col gap-2">
                {people.map((personIdx) => {
                  const personId = String(context.people[personIdx]?.id ?? personIdx);
                  return (
                    <div
                      key={personIdx}
                      data-testid="roster-day-person"
                      data-person={personId}
                      className="flex items-center gap-2 border border-line2 bg-surface px-2 py-1.5"
                    >
                      <span className="min-w-0 flex-1 text-meta font-semibold text-ink">
                        {personId}
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
                  );
                })}
                {people.length === 0 ? (
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

/** Everyone who is resting or on paid leave today, each named as which. */
function OffLeaveList({
  context,
  currentDays,
  dateIdx,
}: {
  context: RosterContext;
  currentDays: RosterDayGrid;
  dateIdx: number;
}) {
  const resting = context.people
    .map((person, personIdx) => ({ person, cell: currentDays[personIdx]?.[dateIdx] }))
    .filter(({ cell }) => cell !== undefined && (cell.kind === "off" || cell.kind === "leave"));

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2.5 border-t border-line2 pt-3.5">
      <span className="font-ui text-label font-semibold uppercase tracking-[0.04em] text-ink3">
        Off / leave
      </span>
      {resting.map(({ person, cell }) => {
        const isLeave = cell?.kind === "leave";
        return (
          <span
            key={typedIdKey(person.id)}
            className={cn(
              "inline-flex h-6 items-center rounded-pill bg-panel px-2.5",
              "font-mono text-label font-semibold",
              // Leave is NEUTRAL everywhere. Brand tint is the system's selection
              // language; spending it on a leave marker both misreads as selected
              // and contradicts the rule the ShiftChip already follows.
              isLeave ? "text-ink2" : "text-ink3",
            )}
          >
            {String(person.id)} · {isLeave ? "Leave" : "Off"}
          </span>
        );
      })}
      {resting.length === 0 ? (
        <span className="text-meta text-ink3">Everyone is on duty.</span>
      ) : null}
    </div>
  );
}
