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

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { paidMinutesFor, validateWorkingTimeDraft, type WorkingTimeValue } from "./core";

const PAD = (n: number) => String(n).padStart(2, "0");
/** The 48 half-hour clock slots 00:00..23:30 (the design's timeOptions). */
const TIME_OPTIONS: string[] = Array.from({ length: 48 }, (_, i) => {
  const h = Math.floor((i * 30) / 60);
  const m = (i * 30) % 60;
  return `${PAD(h)}:${PAD(m)}`;
});

/** Format minutes as the design's "8h" / "8h 30m" readout. */
function fmtHours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

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
    <div className="flex flex-col gap-2" data-testid={`${idPrefix}-wt`}>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-label font-semibold uppercase tracking-[0.03em] text-ink3">
            Start
          </span>
          <select
            data-testid={`${idPrefix}-start`}
            className="h-9 rounded-none border border-line bg-surface px-2 font-mono text-body text-ink"
            value={start}
            onChange={(e) => set({ startTime: e.target.value || undefined })}
          >
            <option value="">--:--</option>
            {TIME_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <span className="pb-2 text-ink3">–</span>
        <label className="flex flex-col gap-1">
          <span className="text-label font-semibold uppercase tracking-[0.03em] text-ink3">
            End
          </span>
          <select
            data-testid={`${idPrefix}-end`}
            className="h-9 rounded-none border border-line bg-surface px-2 font-mono text-body text-ink"
            value={end}
            onChange={(e) => set({ endTime: e.target.value || undefined })}
          >
            <option value="">--:--</option>
            {TIME_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        {overnight && (
          <span className="mb-2 border border-line2 px-2 py-1 font-mono text-label text-ink3">
            +1 day
          </span>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-label font-semibold uppercase tracking-[0.03em] text-ink3">
            Rest
          </span>
          <select
            data-testid={`${idPrefix}-rest`}
            className="h-9 rounded-none border border-line bg-surface px-2 font-mono text-body text-ink"
            value={String(rest)}
            onChange={(e) => set({ restMinutes: Number(e.target.value) || undefined })}
          >
            {restOptions.map((m) => (
              <option key={m} value={String(m)}>
                {m === 0 ? "No rest" : fmtHours(m)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-[8rem] flex-col gap-1">
          <span className="text-label font-semibold uppercase tracking-[0.03em] text-ink3">
            Working <span className="text-faint">· auto</span>
          </span>
          <Input
            data-testid={`${idPrefix}-duration`}
            aria-label="Working minutes (auto)"
            readOnly
            tabIndex={-1}
            className="h-9 border-line2 bg-panel font-mono"
            value={paid != null ? String(paid) : ""}
            placeholder="—"
          />
        </label>
      </div>

      {firstError && (
        <span className="text-label text-error" role="alert" data-testid={`${idPrefix}-wt-error`}>
          {firstError}
        </span>
      )}

      {(start || end || rest || value.durationMinutes != null) && (
        <div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onChange({})}
            data-testid={`${idPrefix}-wt-clear`}
          >
            Clear working time
          </Button>
        </div>
      )}
    </div>
  );
}
