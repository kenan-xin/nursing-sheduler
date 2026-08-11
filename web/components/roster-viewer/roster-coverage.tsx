"use client";

// Roster Coverage lens (F4, rebuilt for G7) — read-only, and the detailed
// staffing-audit surface.
//
// TWO PLANES, ALWAYS. There is no hierarchy classifier and no fallback mode:
//
//   1. Declared requirements — one row per backend staffing equation, with the
//      scope the scenario actually wrote (`AllMornings`, `MorningSeniorSlots`
//      qualified to `SeniorStaffNurses`), its coverage units against the declared
//      target, and its hard-constraint verdicts. A shortage appears ONLY on the
//      equation that declares the target.
//   2. Exact shifts — every concrete shift id once, with hours, staffed count and
//      the people on it. A shift that feeds several equations still appears once.
//
// A group minimum is never divided across its member shifts. Every assigned
// person is named by their full authored/de-anonymized id, because Ward ids such
// as `SSN-Siti`, `SSN-MeiLing` and `SN-HuiMin` all collapse to the same initials.
//
// Geometry follows ScreenSchedule/DESIGN: a 212px sticky context lane and 128px
// day tracks that scroll horizontally INSIDE the card. Narrow (below 760px of
// roster content) stacks into one card per day — driven by the shared roster
// content width, not a viewport media query, because a future docked assistant
// may narrow the roster while the viewport stays wide.

import { cn } from "@/lib/utils";
import { typedIdKey } from "@/lib/roster";
import type { RosterContext, RosterContextShiftType } from "@/lib/roster";
import {
  dateLabel,
  shiftContextLabel,
  shiftTimeRange,
  uniformShiftRequirement,
  type CoverageGrid,
  type RequirementCell,
  type RequirementEquation,
  type RequirementGrid,
  type RequirementModel,
  type ShiftRampEntry,
} from "@/lib/roster-viewer";
import type { ContainerWidth } from "./use-container-width";

export interface RosterCoverageProps {
  context: RosterContext;
  ramp: Map<string, ShiftRampEntry>;
  /** The Exact shifts plane. */
  coverage: CoverageGrid;
  /** The ephemeral equation definitions. */
  model: RequirementModel;
  /** `[equationIdx][dateIdx]` verdicts for those definitions. */
  requirements: RequirementGrid;
  width: ContainerWidth;
}

const HOLIDAY_STRIPE =
  "bg-[repeating-linear-gradient(135deg,var(--warntint)_0_3px,var(--surface)_3px_9px)]";

/** ScreenSchedule/DESIGN Coverage geometry: 212px context lane, 128px day tracks. */
const COVERAGE_LABEL_LANE = 212;
const COVERAGE_DAY_TRACK = 128;

function coverageColumns(dayCount: number): string {
  return `${COVERAGE_LABEL_LANE}px repeat(${dayCount}, ${COVERAGE_DAY_TRACK}px)`;
}

export function RosterCoverage({
  context,
  ramp,
  coverage,
  model,
  requirements,
  width,
}: RosterCoverageProps) {
  return (
    <div className="flex flex-col gap-3" data-testid="roster-coverage">
      <CoverageLegend />
      {width.stacked ? (
        <CoverageStacked
          context={context}
          ramp={ramp}
          coverage={coverage}
          model={model}
          requirements={requirements}
        />
      ) : (
        <CoverageWide
          context={context}
          ramp={ramp}
          coverage={coverage}
          model={model}
          requirements={requirements}
        />
      )}
    </div>
  );
}

/**
 * The compact legend the prototype carries above Coverage. It explains the one
 * treatment that is otherwise colour-only, and states what a cell contains — the
 * `Help and documentation` gap the fidelity review scored 1/10.
 */
function CoverageLegend() {
  return (
    <div
      data-testid="roster-coverage-legend"
      className="flex flex-wrap items-center gap-x-4 gap-y-2"
    >
      <span className="inline-flex items-center gap-2 text-meta font-medium text-ink2">
        <span className="size-4 shrink-0 border border-error bg-errortint" aria-hidden />
        Hard constraint not met
      </span>
      <span className="inline-flex items-center gap-2 text-meta font-medium text-ink2">
        <span className="size-4 shrink-0 border border-line2 bg-surface" aria-hidden />
        Satisfied
      </span>
      <span className="text-meta text-ink3">
        Declared requirements show coverage / required for the scope the schedule states. Exact
        shifts show who is on, every day.
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared vocabulary for a declared-equation verdict.
// ---------------------------------------------------------------------------

/**
 * The hard verdicts that failed, as text.
 *
 * Colour is never the only carrier: every mismatch names itself, and the three
 * reasons are independent because the backend builds them as separate
 * constraints — a qualified row can read `1/1` and still be `Unqualified 1`.
 */
function mismatchLabels(cell: Extract<RequirementCell, { status: "checked" }>): string[] {
  const labels: string[] = [];
  if (cell.short > 0) labels.push(`Short ${cell.short}`);
  if (cell.over > 0) labels.push(`Over ${cell.over}`);
  if (cell.unqualified > 0) labels.push(`Unqualified ${cell.unqualified}`);
  return labels;
}

/** The declared target, spelled the way the scenario states it. */
function targetLabel(equation: RequirementEquation): string {
  const unit = equation.weighted ? "coverage units" : "required";
  return equation.preferred === null
    ? `${equation.required} ${unit} exactly`
    : `${equation.required}–${equation.preferred} ${unit}`;
}

/** A complete spoken description of one equation cell, for `title`/`aria-label`. */
function cellDescription(
  equation: RequirementEquation,
  cell: RequirementCell,
  dayText: string,
): string {
  const scope = `${equation.scopeLabel} on ${dayText}`;
  if (cell.status === "unavailable") return `${scope} — unavailable: ${cell.reason}`;
  if (cell.status === "not-applicable") return `${scope} — not applicable on this date`;
  const noun = equation.weighted ? "coverage units" : "people";
  const head = `${scope} — ${cell.units} of ${cell.required} ${noun}`;
  const failures = mismatchLabels(cell);
  return failures.length === 0 ? `${head}, satisfied` : `${head}, ${failures.join(", ")}`;
}

/** The equation's context lane: scope, qualification, target and description. */
function EquationLabel({ equation }: { equation: RequirementEquation }) {
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-mono text-meta font-bold text-ink">{equation.scopeLabel}</span>
        {equation.qualifiedLabel !== null ? (
          <span className="rounded-chip border border-line2 bg-panel px-1.5 py-0.5 font-ui text-label font-semibold text-ink2">
            qualified: {equation.qualifiedLabel}
          </span>
        ) : null}
        {equation.weighted ? (
          <span className="rounded-chip border border-line2 bg-panel px-1.5 py-0.5 font-ui text-label font-semibold text-ink2">
            weighted
          </span>
        ) : null}
      </div>
      <div className="mt-0.5 font-mono text-label font-medium text-ink3">
        {equation.unavailable === null ? targetLabel(equation) : "unavailable"}
        {equation.dateLabel === "Every day" ? "" : ` · ${equation.dateLabel}`}
      </div>
      {equation.description !== null ? (
        <div className="mt-1 line-clamp-2 text-label text-ink3" title={equation.description}>
          {equation.description}
        </div>
      ) : null}
      {equation.unavailable !== null ? (
        <div className="mt-1 text-label text-warnink">{equation.unavailable}</div>
      ) : null}
    </>
  );
}

/** The exact shift's context lane: colour key, id, hours, description. */
function ShiftLabel({
  shift,
  rampEntry,
  required,
}: {
  shift: RosterContextShiftType;
  rampEntry: ShiftRampEntry | undefined;
  required: number | null;
}) {
  const time = shiftTimeRange(shift);
  return (
    <>
      <div className="flex items-center gap-2">
        <span
          className="size-2.5 shrink-0 rounded-[3px]"
          style={{ backgroundColor: rampEntry?.bar ?? "var(--line)" }}
          aria-hidden
        />
        <span className="whitespace-nowrap text-meta font-bold text-ink">{String(shift.id)}</span>
        {time !== null ? (
          <span className="whitespace-nowrap font-mono text-label font-medium text-ink3">
            {time}
          </span>
        ) : null}
      </div>
      {required !== null ? (
        <div className="ml-[18px] font-mono text-label font-medium text-ink3">min {required}</div>
      ) : null}
      {shift.description !== undefined ? (
        <div
          className="ml-[18px] mt-0.5 line-clamp-2 text-label text-ink3"
          title={shift.description}
        >
          {shift.description}
        </div>
      ) : null}
    </>
  );
}

/** A person on a shift, always by their FULL authored id. */
function PersonChip({ id, className }: { id: string; className?: string }) {
  return (
    <span
      data-testid="roster-coverage-person"
      data-person={id}
      title={id}
      className={cn(
        "inline-flex items-center rounded-pill border border-line2 bg-panel px-1.5 py-px",
        "font-mono text-label font-semibold text-ink2",
        className,
      )}
    >
      {id}
    </span>
  );
}

/** The one place a "nobody is assigned" statement is worded. */
function NobodyAssigned() {
  return <span className="text-label text-ink3">Nobody assigned</span>;
}

// ---------------------------------------------------------------------------
// Wide: 212px sticky context lane + 128px day tracks, scrolling inside the card.
// ---------------------------------------------------------------------------

function CoverageWide({
  context,
  ramp,
  coverage,
  model,
  requirements,
}: Omit<RosterCoverageProps, "width">) {
  const calendar = context.calendar;
  const columns = coverageColumns(calendar.length);

  return (
    <div
      data-testid="roster-coverage-wide"
      className="overflow-auto rounded-card border border-line bg-surface shadow-1"
      style={{ maxHeight: "66vh" }}
    >
      <div style={{ minWidth: "max-content", padding: 8 }}>
        {/* Day header row. */}
        <div className="grid items-end gap-1.5" style={{ gridTemplateColumns: columns }}>
          <div className="sticky left-0 z-[2] bg-surface" />
          {calendar.map((day, dateIdx) => (
            <div
              key={day.iso}
              className={cn(
                "px-0 pb-2 pt-1.5 text-center",
                day.holiday && HOLIDAY_STRIPE,
                day.weekend && !day.holiday && "bg-panel",
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

        <PlaneHeading
          id="roster-coverage-declared-heading"
          text="Declared requirements"
          detail="What the schedule actually asks for, at the scope it asks for it."
        />
        <div
          data-testid="roster-coverage-declared"
          role="group"
          aria-labelledby="roster-coverage-declared-heading"
        >
          {model.reason !== null ? (
            <p
              className="px-1 py-2 text-meta text-warnink"
              data-testid="roster-coverage-model-unavailable"
            >
              The staffing requirements could not be read from this roster ({model.reason}).
            </p>
          ) : null}
          {model.reason === null && model.equations.length === 0 ? (
            <p className="px-1 py-2 text-meta text-ink3">
              This schedule states no staffing requirements.
            </p>
          ) : null}
          {model.equations.map((equation, equationIdx) => (
            <div
              key={equation.key}
              data-testid="roster-requirement-row"
              data-equation={equation.key}
              data-scope={equation.scopeLabel}
              className="mt-1.5 grid items-stretch gap-1.5"
              style={{ gridTemplateColumns: columns }}
            >
              <div className="sticky left-0 z-[2] flex flex-col justify-center bg-surface px-3 py-2">
                <EquationLabel equation={equation} />
              </div>
              {calendar.map((day, dateIdx) => (
                <RequirementDayCell
                  key={day.iso}
                  equation={equation}
                  cell={requirements[equationIdx]?.[dateIdx] ?? { status: "not-applicable" }}
                  dayText={`${dateLabel(calendar, dateIdx)} ${day.weekday}`}
                  holiday={day.holiday}
                  weekend={day.weekend}
                />
              ))}
            </div>
          ))}
        </div>

        <PlaneHeading
          id="roster-coverage-exact-heading"
          text="Exact shifts"
          detail="Every concrete shift once, with who is on it."
        />
        <div
          data-testid="roster-coverage-exact"
          role="group"
          aria-labelledby="roster-coverage-exact-heading"
        >
          {context.shiftTypes.map((shift, shiftIdx) => (
            <div
              key={typedIdKey(shift.id)}
              data-testid="roster-exact-shift-row"
              data-shift={String(shift.id)}
              className="mt-1.5 grid items-stretch gap-1.5"
              style={{ gridTemplateColumns: columns }}
            >
              <div className="sticky left-0 z-[2] flex flex-col justify-center bg-surface px-3 py-2">
                <ShiftLabel
                  shift={shift}
                  rampEntry={ramp.get(typedIdKey(shift.id))}
                  required={uniformShiftRequirement(coverage, shiftIdx)}
                />
              </div>
              {calendar.map((day, dateIdx) => {
                const cell = coverage[dateIdx]?.shifts[shiftIdx];
                const people = cell?.people ?? [];
                const label = `${shiftContextLabel(shift)} on ${dateLabel(calendar, dateIdx)} ${day.weekday} — ${people.length} staffed${
                  cell?.required != null ? ` of ${cell.required} required` : ""
                }${people.length === 0 ? "" : `: ${people.map((personIdx) => String(context.people[personIdx]?.id ?? "")).join(", ")}`}`;
                return (
                  <div
                    key={day.iso}
                    title={label}
                    aria-label={label}
                    data-short={cell?.short === true ? "true" : "false"}
                    // Machine-readable staffing, so an oracle can compare all
                    // 16 x 28 lanes against the stored document instead of
                    // scraping prose.
                    data-staffed={people.length}
                    data-people={people
                      .map((personIdx) => String(context.people[personIdx]?.id ?? ""))
                      .join(",")}
                    className={cn(
                      // Square: DESIGN.md holds every DATA surface square, and a
                      // coverage grid cell is data, not a chip.
                      "min-h-[72px] border p-1.5",
                      cell?.short === true
                        ? "border-error bg-errortint"
                        : "border-line2 bg-surface",
                      day.holiday && HOLIDAY_STRIPE,
                      day.weekend && !day.holiday && cell?.short !== true && "bg-panel",
                    )}
                  >
                    <div className="mb-1 flex items-baseline justify-between gap-1">
                      <span
                        className={cn(
                          "font-mono text-label-lg font-bold",
                          cell?.short === true ? "text-errorink" : "text-ink",
                        )}
                      >
                        {people.length}
                        {cell?.required != null ? (
                          <span className="font-medium text-ink3">/{cell.required}</span>
                        ) : null}
                      </span>
                      {cell?.short === true ? (
                        <span className="font-ui text-label font-bold uppercase tracking-[0.04em] text-errorink">
                          Short
                        </span>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {people.map((personIdx) => (
                        <PersonChip
                          key={personIdx}
                          id={String(context.people[personIdx]?.id ?? personIdx)}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * A plane divider. Deliberately NOT an `h2`/`h3` at display size: the route
 * already owns the page heading, and the fidelity review's strongest hierarchy
 * finding was that competing large headings delay the roster.
 */
function PlaneHeading({ id, text, detail }: { id: string; text: string; detail: string }) {
  return (
    <div className="sticky left-0 mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1 pb-1">
      <span
        id={id}
        className="font-ui text-label font-semibold uppercase tracking-[0.04em] text-brandink"
      >
        {text}
      </span>
      <span className="text-label text-ink3">{detail}</span>
    </div>
  );
}

/** One equation × one day. */
function RequirementDayCell({
  equation,
  cell,
  dayText,
  holiday,
  weekend,
}: {
  equation: RequirementEquation;
  cell: RequirementCell;
  dayText: string;
  holiday: boolean;
  weekend: boolean;
}) {
  const description = cellDescription(equation, cell, dayText);
  const mismatch = cell.status === "checked" && cell.mismatch;
  return (
    <div
      title={description}
      aria-label={description}
      data-status={cell.status}
      data-mismatch={mismatch ? "true" : "false"}
      // The equation's numbers, machine-readable, for the same reason. Named
      // `shortfall` rather than `short` because `data-short` already means the
      // boolean "this EXACT shift is under its declared target" on the other
      // plane, and one attribute name with two meanings is a trap.
      data-units={cell.status === "checked" ? cell.units : undefined}
      data-required={cell.status === "checked" ? cell.required : undefined}
      data-shortfall={cell.status === "checked" ? cell.short : undefined}
      data-over={cell.status === "checked" ? cell.over : undefined}
      data-unqualified={cell.status === "checked" ? cell.unqualified : undefined}
      className={cn(
        "flex min-h-[56px] flex-col justify-center border px-1.5 py-1",
        mismatch ? "border-error bg-errortint" : "border-line2 bg-surface",
        cell.status === "unavailable" && "border-warn bg-warntint",
        holiday && HOLIDAY_STRIPE,
        weekend && !holiday && !mismatch && cell.status !== "unavailable" && "bg-panel",
      )}
    >
      {cell.status === "not-applicable" ? (
        <span className="text-center font-mono text-label text-ink3">n/a</span>
      ) : null}
      {cell.status === "unavailable" ? (
        <span className="text-center font-mono text-label font-semibold text-warnink">
          unavailable
        </span>
      ) : null}
      {cell.status === "checked" ? (
        <>
          <span
            className={cn(
              "font-mono text-label-lg font-bold",
              cell.mismatch ? "text-errorink" : "text-ink",
            )}
          >
            {cell.units}
            <span className="font-medium text-ink3">/{cell.required}</span>
          </span>
          {mismatchLabels(cell).map((label) => (
            <span
              key={label}
              data-testid="roster-requirement-mismatch"
              className="font-ui text-label font-bold uppercase tracking-[0.04em] text-errorink"
            >
              {label}
            </span>
          ))}
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stacked: one card per day, both planes inside it, no horizontal scrolling.
// ---------------------------------------------------------------------------

function CoverageStacked({
  context,
  ramp,
  coverage,
  model,
  requirements,
}: Omit<RosterCoverageProps, "width">) {
  const calendar = context.calendar;

  return (
    <div data-testid="roster-coverage-stacked" className="space-y-2.5">
      {calendar.map((day, dateIdx) => {
        const dayText = `${dateLabel(calendar, dateIdx)} ${day.weekday}`;
        return (
          <div key={day.iso} className="rounded-card border border-line2 bg-surface">
            <div
              className={cn(
                "flex items-baseline gap-2 border-b border-line2 px-3 py-2",
                day.weekend && !day.holiday && "bg-panel",
                day.holiday && HOLIDAY_STRIPE,
              )}
            >
              <span className="font-mono text-title font-bold leading-none text-ink">
                {dateLabel(calendar, dateIdx)}
              </span>
              <span className="font-ui text-meta font-semibold text-ink2">{day.weekday}</span>
            </div>

            <div className="px-3 py-2">
              <PlaneLabel text="Declared requirements" />
              {model.equations.length === 0 ? (
                <p className="py-1 text-label text-ink3">
                  {model.reason === null
                    ? "This schedule states no staffing requirements."
                    : `The staffing requirements could not be read from this roster (${model.reason}).`}
                </p>
              ) : null}
              {model.equations.map((equation, equationIdx) => {
                const cell = requirements[equationIdx]?.[dateIdx] ?? {
                  status: "not-applicable" as const,
                };
                if (cell.status === "not-applicable") return null;
                const mismatch = cell.status === "checked" && cell.mismatch;
                const description = cellDescription(equation, cell, dayText);
                return (
                  <div
                    key={equation.key}
                    data-testid="roster-requirement-row"
                    data-equation={equation.key}
                    data-scope={equation.scopeLabel}
                    data-status={cell.status}
                    data-mismatch={mismatch ? "true" : "false"}
                    title={description}
                    className={cn(
                      "flex items-start justify-between gap-2.5 border-t border-line2 py-2",
                      mismatch && "border-error bg-errortint",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <EquationLabel equation={equation} />
                    </div>
                    <div className="flex shrink-0 flex-col items-end">
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
                      {cell.status === "checked"
                        ? mismatchLabels(cell).map((label) => (
                            <span
                              key={label}
                              data-testid="roster-requirement-mismatch"
                              className="font-ui text-label font-bold uppercase tracking-[0.04em] text-errorink"
                            >
                              {label}
                            </span>
                          ))
                        : null}
                    </div>
                  </div>
                );
              })}

              <PlaneLabel text="Exact shifts" className="mt-3" />
              {context.shiftTypes.map((shift, shiftIdx) => {
                const cell = coverage[dateIdx]?.shifts[shiftIdx];
                const people = cell?.people ?? [];
                const rampEntry = ramp.get(typedIdKey(shift.id));
                return (
                  <div
                    key={typedIdKey(shift.id)}
                    data-testid="roster-exact-shift-row"
                    data-shift={String(shift.id)}
                    data-short={cell?.short === true ? "true" : "false"}
                    className={cn(
                      "flex items-start gap-2.5 border-t border-line2 py-2",
                      cell?.short === true && "border-error bg-errortint",
                    )}
                  >
                    <span
                      className="mt-1 size-2.5 shrink-0 rounded-[3px]"
                      style={{ backgroundColor: rampEntry?.bar ?? "var(--line)" }}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex items-baseline justify-between gap-2">
                        <span
                          className="min-w-0 text-meta font-bold text-ink"
                          title={shiftContextLabel(shift)}
                        >
                          {String(shift.id)}
                          {shiftTimeRange(shift) !== null ? (
                            <span className="ml-1.5 font-mono text-label font-medium text-ink3">
                              {shiftTimeRange(shift)}
                            </span>
                          ) : null}
                        </span>
                        <span
                          className={cn(
                            "shrink-0 font-mono text-label-lg font-bold",
                            cell?.short === true ? "text-errorink" : "text-ink",
                          )}
                        >
                          {people.length}
                          {cell?.required != null ? (
                            <span className="font-medium text-ink3">/{cell.required}</span>
                          ) : null}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {people.map((personIdx) => (
                          <PersonChip
                            key={personIdx}
                            id={String(context.people[personIdx]?.id ?? personIdx)}
                          />
                        ))}
                        {people.length === 0 ? <NobodyAssigned /> : null}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PlaneLabel({ text, className }: { text: string; className?: string }) {
  return (
    <div
      className={cn(
        "font-ui text-label font-semibold uppercase tracking-[0.04em] text-brandink",
        className,
      )}
    >
      {text}
    </div>
  );
}
