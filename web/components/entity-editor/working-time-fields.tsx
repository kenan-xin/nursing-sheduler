"use client";

// Shift-type working-time sub-form (T09), following the design prototype
// (ScreenShifts.dc.html): start/end are picked from a 30-minute-grid <select>, rest
// from a multiple-of-30 select, and the paid working duration is auto-derived
// (clock span − rest) and shown read-only — so the producer's "durationMinutes must
// equal paid minutes" rule holds by construction and off-grid text can never be
// entered.
//
// The controlled value ALWAYS carries the derived `durationMinutes` (spec 01
// FR-DM-28): whenever the clocks/rest change we recompute the paid minutes and write
// them back, so the T05 whole-shape rule ("durationMinutes is required when
// startTime and endTime are set") is satisfied without the caller re-deriving it,
// and the value can be persisted verbatim. A Clear action removes all four fields.
// Validation (equal start/end, partial clock) comes from the T05-reused validator.
//
// DL10: no role/seniority here. durationMinutes is authoring-only.
//
// Durations read in DECIMAL hours — the prototype's `fmtH` ("11.5h", not "11h 30m") —
// for the headline figure; rest keeps the hours-and-minutes form the prototype uses
// for it.
//
// The caption keeps the prototype's `= <clock span> − <rest>` (ScreenShifts.dc.html:330)
// on ONE line beside the figure, with two changes. No rest is written `− 0` rather
// than `− no rest`, and the Rest select's zero option is "None" rather than "No rest":
// six and three characters back, and `− 0` keeps the caption one arithmetic shape at
// every rest value. The leading `=` stays because it is load-bearing — without it
// "11.5h − 30m" reads as a subtraction still to be done and invites you to land on
// 11h, when the break is already out.
//
// This row does not fit at 1280 and that is a KNOWN, ACCEPTED trade (user call,
// 2026-07-26), not an oversight. Measured there: the row has 252px, while one line
// wants ~277px — 102px for the Rest select at "1h 30m" and ~175px for the readout at
// "= 12h − 30m" beside an 11.5h figure. So the column split is pushed to 1fr / 1.6fr
// and the caption still ellipsises on a break of 1h 30m or more; the prototype
// anticipates exactly this with text-overflow:ellipsis on the same span, and the
// box's title carries the full sentence. Everything fits from ~1440px up. The
// alternative that fits at 1280 is stacking the caption under the figure, which was
// built and measured (all cases fit) and rejected for the taller box.
//
// Before re-tuning any of this: measure the REST select by testid, not the first
// <select> in the row, and measure its label with canvas metrics — a <select> reports
// no overflow of its own, so scrollWidth checks silently pass while it clips.
//
// R2c owns this sub-form's PRESENTATION (Shift Types is its only live UI consumer).
// v2: the derived Working readout is an inset `well` on the control radius at the
// absolute 36px control height, matching the two Selects beside it and growing to a
// real 44px on a coarse pointer; the overnight marker is the shared Badge on the
// chip radius; the validation message uses the deepest semantic tier `--errorink`.
// The derivation, the 30-minute grid, the validator and every `data-testid` are
// unchanged.

import * as React from "react";
import { paidMinutesFor, validateWorkingTimeDraft, type WorkingTimeValue } from "./core";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { InfoTip } from "@/components/ui/info-tip";
import { Select } from "@/components/ui/select";
import { surfaceVariants } from "@/components/ui/surface";

const PAD = (n: number) => String(n).padStart(2, "0");
/** The 48 half-hour clock slots 00:00..23:30 (the design's timeOptions). */
const TIME_OPTIONS: string[] = Array.from({ length: 48 }, (_, i) => {
  const h = Math.floor((i * 30) / 60);
  const m = (i * 30) % 60;
  return `${PAD(h)}:${PAD(m)}`;
});

/** Rest reads in hours-and-minutes — the prototype's `restOptions` / `restReadable`
 *  form: "1h 30m", "1h", "30m" (a zero hour is dropped, never "0h 30m"). */
function fmtRest(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Durations read in decimal hours — the prototype's `fmtH`: "8h", "11.5h". Both the
 *  headline figure and the clock span in the derivation use it. */
function fmtDuration(minutes: number): string {
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

const TIME_TIP =
  "Start and end are the on-the-floor clock times shown on the roster. They fall on the half-hour (HH:00 or HH:30). They do NOT set the paid length — enter rest time separately below and working hours are calculated for you, because unpaid breaks make the clock span longer than the hours that count.";
const REST_TIP =
  "Total unpaid break time during the shift — a whole number of half-hours (multiple of 30 minutes), less than the clock span. Working hours = clock span − rest time, calculated automatically. An 08:00–17:00 shift (9h clock span) with 1h rest = 8 working hours.";

/**
 * Recompute a whole working-time value from a clock/rest edit: the paid
 * `durationMinutes` is derived (`null` when the clocks are absent/equal/off-grid),
 * and zero rest is canonically omitted. Callers always get a value whose
 * durationMinutes agrees with the clocks, so it validates and persists as-is.
 */
function deriveValue(next: WorkingTimeValue): WorkingTimeValue {
  const startTime = next.startTime || undefined;
  const endTime = next.endTime || undefined;
  const restMinutes = next.restMinutes ? next.restMinutes : undefined;
  const paid = paidMinutesFor(startTime, endTime, restMinutes);
  return {
    startTime,
    endTime,
    restMinutes,
    durationMinutes: paid ?? undefined,
  };
}

export interface WorkingTimeFieldsProps {
  value: WorkingTimeValue;
  onChange: (next: WorkingTimeValue) => void;
  idPrefix: string;
}

export function WorkingTimeFields({ value, onChange, idPrefix }: WorkingTimeFieldsProps) {
  const { issues } = React.useMemo(() => validateWorkingTimeDraft(value), [value]);
  const start = value.startTime ?? "";
  const end = value.endTime ?? "";
  const rest = value.restMinutes ?? 0;
  const paid = value.durationMinutes ?? paidMinutesFor(start || undefined, end || undefined, rest);
  const overnight = paid != null && start && end ? end <= start : false;

  const set = (patch: Partial<WorkingTimeValue>) => onChange(deriveValue({ ...value, ...patch }));

  // Rest options go up to (span − 30) once a clock pair is chosen, else just 0.
  const restCap = paid != null ? paid + rest - 30 : 0;
  const restOptions: number[] = [];
  for (let m = 0; m <= Math.max(restCap, rest); m += 30) restOptions.push(m);
  if (rest > 0 && !restOptions.includes(rest)) restOptions.push(rest);

  const firstError = issues[0]?.message;

  return (
    <div className="flex flex-col gap-3" data-testid={`${idPrefix}-wt`}>
      {/* Rest | Working share a row as in the prototype, but not 50/50 — see the
          header note: the Rest select takes only the width it needs, so the spare
          width in its column goes to the readout, which needs every pixel for its
          caption.

          `max-content` rather than a ratio because the select's need is not a
          constant anyone can hold in their head: it is the widest option ("11h 30m")
          plus the caret gutter the shared Select reserves, both of which sit on the
          baked 0.9 spacing scale. A 1fr/1.6fr split happened to give it 78px, which
          was 16px short of that once the caret gutter landed — a native select has
          no ellipsis and no title, so it silently chopped glyphs ("No res"). The
          readout absorbs the remainder instead: its caption truncates cleanly and
          carries the full sentence on the box's title.

          Measured across 700–1920 at the now-single 0.9 scale: Rest never clips
          and the row never overflows. */}
      <div className="grid grid-cols-1 gap-x-3 gap-y-3 sm:grid-cols-[minmax(0,max-content)_minmax(0,1fr)]">
        <div className="flex flex-col gap-1 sm:col-span-2">
          <span className="flex items-center gap-1.5 text-label font-semibold uppercase tracking-[0.03em] text-ink3">
            Time on floor
            <InfoTip label="Time on floor" text={TIME_TIP} />
          </span>
          {/* Wraps rather than overflows, and an OVERNIGHT shift is what makes that
              load-bearing: the "+1 day" badge joins the row beside two clock selects
              that each carry the shared Select's caret gutter. Pinned by e2e (see
              "the overnight clock row wraps" in e2e/shift-types.spec.ts): with nowrap,
              children escape the card at 1100 and 1150 at the single 0.9 scale — an
              ordinary night shift, not a corner case — and fit again by 1280. Letting
              the selects shrink instead chops digits off a time with no ellipsis to
              warn you, so wrapping is the graceful failure. */}
          <div data-testid={`${idPrefix}-clocks`} className="flex flex-wrap items-center gap-2">
            <Select
              data-testid={`${idPrefix}-start`}
              aria-label="Start time"
              className="font-mono text-label font-semibold"
              value={start}
              onChange={(e) => set({ startTime: e.target.value || undefined })}
            >
              <option value="">--:--</option>
              {TIME_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
            <span className="text-ink3">–</span>
            <Select
              data-testid={`${idPrefix}-end`}
              aria-label="End time"
              className="font-mono text-label font-semibold"
              value={end}
              onChange={(e) => set({ endTime: e.target.value || undefined })}
            >
              <option value="">--:--</option>
              {TIME_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
            {overnight && (
              // A data mark, not a status eyebrow — `casing="normal"` keeps "+1 day"
              // exactly as it reads. The shared Badge carries the v2 chip radius.
              <Badge variant="outline" casing="normal" className="font-mono">
                +1 day
              </Badge>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <span className="flex items-center gap-1.5 text-label font-semibold uppercase tracking-[0.03em] text-ink3">
            Rest
            <InfoTip label="Rest time" text={REST_TIP} />
          </span>
          <Select
            data-testid={`${idPrefix}-rest`}
            aria-label="Rest time"
            className="font-mono text-label font-bold"
            value={String(rest)}
            onChange={(e) => set({ restMinutes: Number(e.target.value) || undefined })}
          >
            {restOptions.map((m) => (
              <option key={m} value={String(m)}>
                {m === 0 ? "None" : fmtRest(m)}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-label font-semibold uppercase tracking-[0.03em] text-ink3">
            {/* `--faint` is for disabled affordances and empty-cell marks only
                (DESIGN.md §2); "· auto" is a functional qualifier on a real
                label, so it takes the tertiary ink. */}
            Working <span className="text-ink3">· auto</span>
          </span>
          <div
            data-testid={`${idPrefix}-duration`}
            aria-label="Working duration (auto)"
            title={
              paid != null
                ? `${fmtDuration(paid)} working = ${fmtDuration(paid + rest)} on floor − ${
                    rest > 0 ? fmtRest(rest) : "no"
                  } rest`
                : undefined
            }
            // An inset island inside the editor card: `--panel` behind a `--line2`
            // hairline at the control radius, straight from the shared authority.
            // F2's `ii7.8.5` added the `emphasis` axis, so the recipe now emits
            // this exact contract and there is no reason to reimplement it with
            // canonical tokens (technical plan T5).
            //
            // Height is a STYLE, not `h-control`: a recipe consumer's className is
            // held to layout utilities with validated values and the `h` family
            // admits no `control`. Setting `--ctl` directly keeps the absolute
            // token — `h-10` would land on 36px only via the 0.9 density baseline
            // and would drift if that ever moved. Border-box puts the hairline
            // inside the 36px, which is what keeps the readout level with the Rest
            // select beside it; the prototype's own box is 38px because its selects
            // are 38px, and ours are the ratified 36px (D10).
            style={{ height: "var(--ctl)" }}
            className={cn(
              "flex items-center gap-1.5 overflow-hidden px-2.5 pointer-coarse:min-h-touch",
              surfaceVariants({ role: "well", geometry: "control", emphasis: "hairline" }),
            )}
          >
            <span className="flex-none font-heading text-title font-bold leading-none tracking-[-0.015em]">
              {paid != null ? fmtDuration(paid) : "—"}
            </span>
            {paid != null && (
              <span className="min-w-0 truncate font-mono text-label text-ink3">
                = {fmtDuration(paid + rest)} − {rest > 0 ? fmtRest(rest) : "0"}
              </span>
            )}
          </div>
        </div>
      </div>

      {firstError && (
        <span
          className="text-label text-errorink"
          role="alert"
          data-testid={`${idPrefix}-wt-error`}
        >
          {firstError}
        </span>
      )}
    </div>
  );
}
