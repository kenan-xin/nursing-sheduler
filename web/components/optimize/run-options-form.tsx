"use client";

// T16e — run options + submit. Prettify and Anonymize are Switches (the repo's
// toggle primitive); Solver Timeout is a bounded numeric Input. Copy and defaults
// mirror the old application. The submit button owns the idle/submitting states and
// surfaces the disabled reason inline.
//
// B2-2 — the scenario stat grid (NURSES / DAYS / SHIFTS / RULES ON, proto
// ScreenGenerate.dc.html:32-37) sits above the fields; the fields are ordered
// timeout, then (Anonymize, Prettify) per the prototype's `:38-45`.

import { FaDownload, FaSpinner } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { OPTIMIZE_TIMEOUT_MAX_SECONDS, OPTIMIZE_TIMEOUT_MIN_SECONDS } from "@/lib/optimize";
import { cn } from "@/lib/utils";

/** The scenario-at-a-glance counts rendered above the run fields. */
export interface RunOptionsScenarioStats {
  nurses: number;
  days: number;
  shifts: number;
  /** Count of ENABLED rule cards (not the total card count). */
  rulesOn: number;
}

export interface RunOptionsFormProps {
  stats: RunOptionsScenarioStats;
  prettify: boolean;
  anonymize: boolean;
  timeout: string;
  timeoutError: string | null;
  /** Options are locked while a run is active. */
  optionsDisabled: boolean;
  submitEnabled: boolean;
  submitting: boolean;
  disabledReason: string | null;
  onPrettifyChange(value: boolean): void;
  onAnonymizeChange(value: boolean): void;
  onTimeoutChange(value: string): void;
  onSubmit(): void;
}

interface ToggleRowProps {
  id: string;
  label: string;
  help: string;
  checked: boolean;
  disabled: boolean;
  onChange(value: boolean): void;
}

function ToggleRow({ id, label, help, checked, disabled, onChange }: ToggleRowProps) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <Label htmlFor={id} className="normal-case tracking-normal text-body text-ink">
          {label}
        </Label>
        <p className="mt-0.5 text-meta text-ink3">{help}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

interface StatCellProps {
  label: string;
  value: number;
  testId: string;
  borderRight?: boolean;
  borderTop?: boolean;
}

/** One NURSES/DAYS/SHIFTS/RULES ON cell of the scenario stat grid (proto :32-37). */
function StatCell({ label, value, testId, borderRight, borderTop }: StatCellProps) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "px-3.5 py-3",
        borderRight ? "border-r border-line2" : null,
        borderTop ? "border-t border-line2" : null,
      )}
    >
      <div className="font-heading text-title font-extrabold text-ink">{value}</div>
      <div className="mt-0.5 text-label font-semibold uppercase tracking-[0.03em] text-ink3">
        {label}
      </div>
    </div>
  );
}

export function RunOptionsForm({
  stats,
  prettify,
  anonymize,
  timeout,
  timeoutError,
  optionsDisabled,
  submitEnabled,
  submitting,
  disabledReason,
  onPrettifyChange,
  onAnonymizeChange,
  onTimeoutChange,
  onSubmit,
}: RunOptionsFormProps) {
  return (
    <form
      data-testid="optimize-run-options"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      className="space-y-5"
    >
      <div className="grid grid-cols-2 border border-line2" data-testid="optimize-scenario-stats">
        <StatCell label="Nurses" value={stats.nurses} testId="optimize-stat-nurses" borderRight />
        <StatCell label="Days" value={stats.days} testId="optimize-stat-days" />
        <StatCell
          label="Shifts"
          value={stats.shifts}
          testId="optimize-stat-shifts"
          borderRight
          borderTop
        />
        <StatCell
          label="Rules on"
          value={stats.rulesOn}
          testId="optimize-stat-rules-on"
          borderTop
        />
      </div>

      <div className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Label
              htmlFor="optimize-timeout"
              className="normal-case tracking-normal text-body text-ink"
            >
              Solver Timeout
            </Label>
            <p className="mt-0.5 text-meta text-ink3">
              Between {OPTIMIZE_TIMEOUT_MIN_SECONDS} and {OPTIMIZE_TIMEOUT_MAX_SECONDS} seconds.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Input
              id="optimize-timeout"
              type="number"
              inputMode="numeric"
              min={OPTIMIZE_TIMEOUT_MIN_SECONDS}
              max={OPTIMIZE_TIMEOUT_MAX_SECONDS}
              placeholder="300"
              value={timeout}
              disabled={optionsDisabled}
              onChange={(event) => onTimeoutChange(event.target.value)}
              aria-invalid={timeoutError !== null}
              aria-describedby={timeoutError !== null ? "optimize-timeout-error" : undefined}
              className="w-24 text-right font-mono"
            />
            <span className="text-meta text-ink3">sec</span>
          </div>
        </div>
        {timeoutError !== null ? (
          <p
            id="optimize-timeout-error"
            role="alert"
            className="text-meta font-semibold text-error"
          >
            {timeoutError}
          </p>
        ) : null}
        <ToggleRow
          id="optimize-anonymize"
          label="Anonymize schedule data"
          help="Replace people IDs and strip descriptions before sending to the backend."
          checked={anonymize}
          disabled={optionsDisabled}
          onChange={onAnonymizeChange}
        />
        <ToggleRow
          id="optimize-prettify"
          label="Prettify XLSX"
          help="Apply color formatting to the workbook."
          checked={prettify}
          disabled={optionsDisabled}
          onChange={onPrettifyChange}
        />
      </div>

      <div className="space-y-2">
        <Button
          type="submit"
          size="lg"
          disabled={!submitEnabled || submitting}
          data-testid="optimize-submit"
          className="w-full"
        >
          {submitting ? (
            <>
              <FaSpinner className="animate-spin-slow" aria-hidden /> Optimizing…
            </>
          ) : (
            <>
              <FaDownload aria-hidden /> Optimize and Download
            </>
          )}
        </Button>
        {disabledReason !== null && !submitting ? (
          <p className="text-meta text-warn" data-testid="optimize-disabled-reason">
            {disabledReason}
          </p>
        ) : null}
        <p className="text-meta text-ink3">
          Optimizing sends your scheduling data to the backend to generate the XLSX.
        </p>
      </div>
    </form>
  );
}
