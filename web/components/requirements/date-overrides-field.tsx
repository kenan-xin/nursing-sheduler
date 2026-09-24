"use client";

// The "Different number on some dates" rows of the Staffing requirements form. Pure
// presentation: the rows live in RequirementFormState, validation in requirements-model.
// Styled like the form's skill-mix rows (ghost Remove, outline Add, wheel blur).

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { formatShortDate } from "@/lib/dates/date-id";
import { parseRequirementInteger, type OverrideRow } from "./requirements-model";

export interface OverrideDateOption {
  iso: string;
  label: string;
}

interface DateOverridesFieldProps {
  rows: OverrideRow[];
  /** The dates the rule covers now: the only dates a new row may pick. */
  dates: OverrideDateOption[];
  onChange: (rows: OverrideRow[]) => void;
}

/** Blur on wheel so scrolling past a focused field cannot change staffing (EDGE-PR-12). */
function blurOnWheel(e: React.WheelEvent<HTMLInputElement>) {
  (e.target as HTMLInputElement).blur();
}

export function DateOverridesField({ rows, dates, onChange }: DateOverridesFieldProps) {
  const update = (index: number, patch: Partial<OverrideRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const firstFree = dates.find((d) => !rows.some((row) => row.date === d.iso))?.iso;
  return (
    <div className="flex flex-col gap-2" data-testid="date-overrides-field">
      {rows.map((row, index) => (
        // Rows have no identity of their own; index keys are stable while the list only appends and removes.
        <div
          key={index}
          className="flex flex-wrap items-center gap-2"
          data-testid={`date-override-${index}`}
        >
          <Select
            aria-label={`Date of exception ${index + 1}`}
            value={row.date}
            onChange={(e) => update(index, { date: e.target.value })}
          >
            <option value="">Pick a date</option>
            {row.date && !dates.some((d) => d.iso === row.date) && (
              <option value={row.date}>{formatShortDate(row.date, true)}</option>
            )}
            {dates.map((d) => (
              <option key={d.iso} value={d.iso}>
                {d.label}
              </option>
            ))}
          </Select>
          <Input
            type="number"
            min={0}
            step={1}
            aria-label={`Number of people on exception ${index + 1}`}
            className="w-[88px] flex-none font-bold"
            value={row.requiredNumPeople}
            onChange={(e) =>
              update(index, { requiredNumPeople: parseRequirementInteger(e.target.value) })
            }
            onWheel={blurOnWheel}
          />
          <Button
            type="button"
            variant="ghost"
            aria-label={`Remove exception ${index + 1}`}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            Remove
          </Button>
        </div>
      ))}
      <div>
        <Button
          type="button"
          variant="outline"
          data-testid="date-overrides-add"
          disabled={firstFree === undefined}
          onClick={() =>
            firstFree && onChange([...rows, { date: firstFree, requiredNumPeople: "" }])
          }
        >
          Add a date
        </Button>
      </div>
    </div>
  );
}
