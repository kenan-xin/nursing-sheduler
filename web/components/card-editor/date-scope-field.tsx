"use client";

// The design prototype's Dates control (ScreenCards.dc.html:356-380): single-choice
// AUTO-DERIVED scope chips (ALL / weekday / weekend / day-of-week), authored DATE
// GROUP chips, and an "or specific dates" text field (e.g. "1, 5–8, 14").
//
// This is a presentational, fully-controlled control that speaks the card model's
// date-reference list, NOT T10's day-grid DateScopePicker (a different purpose).
// The value/refs mapping preserves DL08 / T13:
//   • empty selection ⇒ ALL scope active ⇒ emits [] (serialized as OMITTED = all
//     dates), never an explicit empty array;
//   • a single derived-keyword or authored-group id ⇒ that scope chip is active;
//   • otherwise the value is concrete date refs shown/edited as specific dates.
// Scope chips are single-choice; the custom text is kept distinct from them.

import * as React from "react";
import { isDerivedDateGroupId } from "@/lib/dates";
import type { DateRef } from "@/lib/scenario";
import { FaCalendarDay, FaLayerGroup } from "@/components/icons";

export interface DateScopeOption {
  id: string;
  label: string;
}

export interface DateScopeItem {
  /** The concrete date ref stored in the card. */
  id: string;
  /** Day-of-month (1-31) used to interpret the specific-dates text. */
  dayOfMonth: number;
}

interface DateScopeFieldProps {
  /** Auto-derived scopes (ALL, WEEKDAY, WEEKEND, MONDAY … SUNDAY). */
  autoScopes: DateScopeOption[];
  /** Authored date groups. */
  dateGroups: DateScopeOption[];
  /** In-range concrete date items, chronological — for the specific-dates field. */
  dateItems: DateScopeItem[];
  /** The current date refs (empty = all dates). A `DateRef` is `number | string`,
   *  so a durable numeric date ref must NOT crash the field; it is preserved
   *  verbatim in the value (treated as a custom, non-renderable ref). */
  value: readonly DateRef[];
  /** Emitted refs are always strings (chip ids or parsed specific dates). */
  onChange: (next: string[]) => void;
}

const ALL_SCOPE = "ALL";

/** Whether the value names a single scope chip (derived keyword or authored
 *  group). A numeric ref is never a scope — return null (custom path) without
 *  calling string-only methods on it (cold-review Major 2). */
function activeScope(value: readonly DateRef[], authored: DateScopeOption[]): string | null {
  if (value.length === 0) return ALL_SCOPE;
  if (value.length !== 1) return null;
  const id = value[0];
  if (typeof id !== "string") return null;
  if (id.toUpperCase() === ALL_SCOPE) return ALL_SCOPE;
  if (isDerivedDateGroupId(id)) return id.toUpperCase();
  if (authored.some((g) => g.id === id)) return id;
  return null;
}

/** Compact concrete date refs into the "1, 5–8, 14" specific-dates text. Numeric
 *  or unknown refs are absent from `dateItems` and so contribute nothing (they are
 *  preserved in the value, not clobbered). */
function refsToText(value: readonly DateRef[], dateItems: DateScopeItem[]): string {
  const byId = new Map(dateItems.map((it, index) => [it.id, { index, day: it.dayOfMonth }]));
  const picked = value
    .map((id) => byId.get(String(id)))
    .filter((x): x is { index: number; day: number } => x !== undefined)
    .sort((a, b) => a.index - b.index);
  if (picked.length === 0) return "";
  const parts: string[] = [];
  let runStart = picked[0];
  let prev = picked[0];
  for (let i = 1; i <= picked.length; i += 1) {
    const cur = picked[i];
    const contiguous = cur && cur.index === prev.index + 1;
    if (!contiguous) {
      parts.push(runStart === prev ? `${runStart.day}` : `${runStart.day}–${prev.day}`);
      if (cur) runStart = cur;
    }
    if (cur) prev = cur;
  }
  return parts.join(", ");
}

/** Parse the specific-dates text into concrete date refs from the range. */
function textToRefs(text: string, dateItems: DateScopeItem[]): string[] {
  const byDay = new Map<number, string>();
  for (const it of dateItems) if (!byDay.has(it.dayOfMonth)) byDay.set(it.dayOfMonth, it.id);
  const seen = new Set<string>();
  const refs: string[] = [];
  const add = (day: number) => {
    const id = byDay.get(day);
    if (id && !seen.has(id)) {
      seen.add(id);
      refs.push(id);
    }
  };
  for (const raw of text.split(",")) {
    const token = raw.trim().replace(/[–—]/g, "-");
    if (token === "") continue;
    const range = token.match(/^(\d{1,2})-(\d{1,2})$/);
    if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      for (let d = Math.min(lo, hi); d <= Math.max(lo, hi); d += 1) add(d);
    } else if (/^\d{1,2}$/.test(token)) {
      add(Number(token));
    }
  }
  // Preserve chronological order regardless of how the text was typed.
  const order = new Map(dateItems.map((it, i) => [it.id, i]));
  return refs.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

function Chip({
  label,
  active,
  group,
  onClick,
}: {
  label: string;
  active: boolean;
  group?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex h-[30px] items-center gap-1.5 whitespace-nowrap border px-[11px] text-meta font-semibold ${
        active
          ? "border-brand bg-brand text-onbrand"
          : group
            ? "border-line2 bg-panel text-ink2 hover:border-brand hover:bg-brandtint"
            : "border-line bg-surface text-ink hover:border-brand hover:bg-brandtint"
      }`}
    >
      {group ? (
        <FaLayerGroup className="size-2.5 opacity-70" />
      ) : (
        <FaCalendarDay className="size-2.5 opacity-70" />
      )}
      {label}
    </button>
  );
}

export function DateScopeField({
  autoScopes,
  dateGroups,
  dateItems,
  value,
  onChange,
}: DateScopeFieldProps) {
  const scope = activeScope(value, dateGroups);
  // Custom text is kept distinct from the chips: it shows only when the value is
  // concrete dates (no scope active). Seeded once per draft from the value.
  const isCustom = scope === null;
  const [text, setText] = React.useState(() => (isCustom ? refsToText(value, dateItems) : ""));

  const selectScope = (id: string) => {
    setText("");
    onChange(id.toUpperCase() === ALL_SCOPE ? [] : [id]);
  };

  const onCustom = (next: string) => {
    setText(next);
    onChange(textToRefs(next, dateItems));
  };

  return (
    <div className="flex flex-col gap-3" data-testid="date-scope-field">
      <div className="flex flex-col gap-1.5">
        <span className="text-label font-semibold uppercase tracking-[0.03em] text-ink3">
          AUTO-DERIVED
        </span>
        <div className="flex flex-wrap gap-1.5">
          {autoScopes.map((s) => (
            <Chip
              key={s.id}
              label={s.label}
              active={!isCustom && scope === s.id.toUpperCase()}
              onClick={() => selectScope(s.id)}
            />
          ))}
        </div>
      </div>

      {dateGroups.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-label font-semibold uppercase tracking-[0.03em] text-ink3">
            DATE GROUPS
          </span>
          <div className="flex flex-wrap gap-1.5">
            {dateGroups.map((g) => (
              <Chip
                key={g.id}
                label={g.label}
                group
                active={!isCustom && scope === g.id}
                onClick={() => selectScope(g.id)}
              />
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <span className="whitespace-nowrap text-meta text-ink3">or specific dates</span>
        <input
          data-testid="date-scope-custom"
          aria-label="Specific dates"
          value={text}
          onChange={(e) => onCustom(e.target.value)}
          placeholder="e.g. 1, 5–8, 14"
          className="h-9 max-w-[220px] flex-1 border border-line bg-surface px-2.5 font-mono text-meta"
        />
      </div>
    </div>
  );
}
