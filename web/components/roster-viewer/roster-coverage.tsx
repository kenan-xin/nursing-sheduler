"use client";

// Roster Coverage lens (F4) — read-only.
//
// One lane per worked shift type across the days. When a unique simple baseline
// exists, each cell shows staffed / required and the initials of who is on,
// flagged "Short" when under minimum. Unsupported/ambiguous baselines show
// "coverage unavailable" rather than a number.
//
// Container-width responsive: wide = one horizontal grid per lane; narrow
// (below 760px roster content) = one card per day. The container-width hook
// drives the switch — this is NOT a viewport media query, because a future
// docked assistant may narrow the roster while the viewport stays wide.

import { cn } from "@/lib/utils";
import { typedIdKey } from "@/lib/roster";
import type { RosterContext, RosterContextPerson, RosterDayGrid } from "@/lib/roster";
import { dateLabel, type CoverageGrid, type ShiftRampEntry } from "@/lib/roster-viewer";
import type { ContainerWidth } from "./use-container-width";

export interface RosterCoverageProps {
  context: RosterContext;
  currentDays: RosterDayGrid;
  ramp: Map<string, ShiftRampEntry>;
  coverage: CoverageGrid;
  width: ContainerWidth;
}

export function RosterCoverage({
  context,
  currentDays,
  ramp,
  coverage,
  width,
}: RosterCoverageProps) {
  return width.stacked ? (
    <CoverageStacked context={context} currentDays={currentDays} ramp={ramp} coverage={coverage} />
  ) : (
    <CoverageWide context={context} currentDays={currentDays} ramp={ramp} coverage={coverage} />
  );
}

// ---------------------------------------------------------------------------
// Wide: one grid per lane, horizontal scroll inside the roster card.
// ---------------------------------------------------------------------------

function CoverageWide({
  context,
  currentDays,
  ramp,
  coverage,
}: {
  context: RosterContext;
  currentDays: RosterDayGrid;
  ramp: Map<string, ShiftRampEntry>;
  coverage: CoverageGrid;
}) {
  const calendar = context.calendar;
  const shiftTypes = context.shiftTypes;
  const HOLIDAY_STRIPE =
    "bg-[repeating-linear-gradient(135deg,var(--warntint)_0_3px,var(--surface)_3px_9px)]";

  return (
    <div
      data-testid="roster-coverage-wide"
      className="overflow-auto rounded-card border border-line bg-surface shadow-1"
      style={{ maxHeight: "66vh" }}
    >
      <div style={{ minWidth: "max-content", padding: 8 }}>
        {/* Day header row. */}
        <div
          className="grid items-end gap-1.5"
          style={{ gridTemplateColumns: `200px repeat(${calendar.length}, minmax(0, 1fr))` }}
        >
          <div />
          {calendar.map((day, dateIdx) => (
            <div
              key={day.iso}
              className={cn(
                "text-center",
                day.holiday && HOLIDAY_STRIPE,
                day.weekend && "bg-panel",
              )}
            >
              <div
                className={cn(
                  "font-mono text-label-md font-bold",
                  day.holiday ? "text-warn" : day.weekend ? "text-ink3" : "text-ink",
                )}
              >
                {dateLabel(calendar, dateIdx)}
              </div>
              <div className="font-mono text-label font-medium text-ink3">{day.weekday}</div>
            </div>
          ))}
        </div>
        {/* One lane per shift type. */}
        {shiftTypes.map((shift, shiftIdx) => {
          const minimum = context.baselineMinimums[shiftIdx];
          const rampEntry = ramp.get(typedIdKey(shift.id));
          return (
            <div
              key={typedIdKey(shift.id)}
              className="mt-1.5 grid items-stretch gap-1.5"
              style={{ gridTemplateColumns: `200px repeat(${calendar.length}, minmax(0, 1fr))` }}
            >
              {/* Lane label. */}
              <div className="flex flex-col justify-center bg-surface px-3">
                <div className="flex items-center gap-2">
                  <span
                    className="size-2.5 shrink-0 rounded-[3px]"
                    style={{ backgroundColor: rampEntry?.bar ?? "var(--line)" }}
                    aria-hidden
                  />
                  <span className="whitespace-nowrap text-meta font-bold text-ink">
                    {String(shift.id)}
                  </span>
                </div>
                <div className="ml-[20px] font-mono text-label font-medium text-ink3">
                  {"unavailable" in minimum ? "coverage unavailable" : `min ${minimum.required}`}
                </div>
              </div>
              {/* Cells. */}
              {calendar.map((day, dateIdx) => {
                const cell = coverage[dateIdx]?.shifts[shiftIdx];
                const assigned = peopleOnShift(currentDays, dateIdx, typedIdKey(shift.id), context);
                if (cell === undefined || cell.status !== "available") {
                  return (
                    <div
                      key={day.iso}
                      className={cn(
                        // Square: DESIGN.md holds every DATA surface square, and a
                        // coverage grid cell is data, not a chip.
                        "flex min-h-[72px] items-center justify-center border border-line2 p-2",
                        day.holiday && HOLIDAY_STRIPE,
                        day.weekend && "bg-panel",
                      )}
                    >
                      <span className="font-mono text-label text-ink3">—</span>
                    </div>
                  );
                }
                return (
                  <div
                    key={day.iso}
                    className={cn(
                      "min-h-[72px] border p-2",
                      cell.short ? "border-error bg-errortint" : "border-line2 bg-surface",
                      day.holiday && HOLIDAY_STRIPE,
                      day.weekend && !cell.short && "bg-panel",
                    )}
                  >
                    <div className="mb-1.5 flex items-center justify-between">
                      <span
                        className={cn(
                          "font-mono text-label-lg font-bold",
                          cell.short ? "text-errorink" : "text-ink",
                        )}
                      >
                        {cell.staffed}
                        <span className="font-medium text-ink3">/{cell.required}</span>
                      </span>
                      {cell.short ? (
                        <span className="font-ui text-label font-bold uppercase tracking-[0.04em] text-errorink">
                          Short
                        </span>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {assigned.map((person) => (
                        <span
                          key={typedIdKey(person.id)}
                          title={String(person.id)}
                          className="inline-flex h-5 items-center rounded-pill border border-line2 bg-panel px-2 font-mono text-label font-semibold text-ink2"
                        >
                          {initials(String(person.id))}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stacked: one card per day (no horizontal scrolling).
// ---------------------------------------------------------------------------

function CoverageStacked({
  context,
  currentDays,
  ramp,
  coverage,
}: {
  context: RosterContext;
  currentDays: RosterDayGrid;
  ramp: Map<string, ShiftRampEntry>;
  coverage: CoverageGrid;
}) {
  const calendar = context.calendar;
  const shiftTypes = context.shiftTypes;
  const HOLIDAY_STRIPE =
    "bg-[repeating-linear-gradient(135deg,var(--warntint)_0_3px,var(--surface)_3px_9px)]";

  return (
    <div data-testid="roster-coverage-stacked" className="space-y-2.5">
      {calendar.map((day, dateIdx) => (
        <div key={day.iso} className="rounded-card border border-line2 bg-surface">
          <div
            className={cn(
              "flex items-center gap-2 border-b border-line2 px-3 py-2",
              day.weekend && "bg-panel",
              day.holiday && HOLIDAY_STRIPE,
            )}
          >
            <span className="font-heading text-body font-bold text-ink">
              {dateLabel(calendar, dateIdx)} · {day.weekday}
            </span>
          </div>
          <div className="px-3 pb-2">
            {shiftTypes.map((shift, shiftIdx) => {
              const cell = coverage[dateIdx]?.shifts[shiftIdx];
              const assigned = peopleOnShift(currentDays, dateIdx, typedIdKey(shift.id), context);
              const rampEntry = ramp.get(typedIdKey(shift.id));
              return (
                <div
                  key={typedIdKey(shift.id)}
                  className="flex items-start gap-2.5 border-t border-line2 py-2.5"
                >
                  <span
                    className="mt-1 size-2.5 shrink-0 rounded-[3px]"
                    style={{ backgroundColor: rampEntry?.bar ?? "var(--line)" }}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <span className="text-meta font-bold text-ink">{String(shift.id)}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        {cell !== undefined && cell.status === "available" ? (
                          <span
                            className={cn(
                              "font-mono text-label-lg font-bold",
                              cell.short ? "text-errorink" : "text-ink",
                            )}
                          >
                            {cell.staffed}
                            <span className="font-medium text-ink3">/{cell.required}</span>
                          </span>
                        ) : (
                          <span className="font-mono text-label text-ink3">unavailable</span>
                        )}
                        {cell !== undefined && cell.status === "available" && cell.short ? (
                          <span className="font-ui text-label font-bold uppercase tracking-[0.04em] text-errorink">
                            Short
                          </span>
                        ) : null}
                      </div>
                    </div>
                    {cell !== undefined && cell.status === "available" ? (
                      <div className="flex flex-wrap gap-1">
                        {assigned.map((person) => (
                          <span
                            key={typedIdKey(person.id)}
                            className="inline-flex h-5 items-center rounded-pill border border-line2 bg-surface px-2 font-mono text-label font-semibold text-ink2"
                          >
                            {initials(String(person.id))}
                          </span>
                        ))}
                        {assigned.length === 0 ? (
                          <span className="text-meta text-ink3">Nobody assigned</span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The people working a given shift on a given day. */
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
