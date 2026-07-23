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
  /** The concrete date ref stored in the card — always full ISO (`YYYY-MM-DD`). */
  id: string;
  /** Day-of-month (1-31). Retained for interface compatibility with the five
   *  `buildDateScopeDateItems` producers; the specific-dates text is now derived
   *  from `id` (month-aware) so multi-month rosters don't collide on day-of-month. */
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
  /**
   * The refs emitted when the ALL scope chip is chosen. Defaults to `[]` — which
   * Coverings relies on: an OMITTED (empty) `date` serializes as "all dates" (DL08),
   * so its optional field must clear to `[]`. A consumer whose date field is
   * REQUIRED (e.g. Counts' `countDates`, where `[]` means "count over zero dates",
   * not "all dates") passes `["ALL"]` so ALL emits the explicit all-dates keyword
   * that also satisfies a non-empty validation. The read path is unaffected:
   * `activeScope` treats BOTH `[]` and `["ALL"]` as ALL-active, so either value
   * shows the ALL chip lit.
   */
  allValue?: readonly string[];
}

const ALL_SCOPE = "ALL";

/** Whether the value names a single scope chip (derived keyword or authored
 *  group). A numeric ref is never a scope — return null (custom path) without
 *  calling string-only methods on it (cold-review Major 2). */
export function activeScope(value: readonly DateRef[], authored: DateScopeOption[]): string | null {
  if (value.length === 0) return ALL_SCOPE;
  if (value.length !== 1) return null;
  const id = value[0];
  if (typeof id !== "string") return null;
  if (id.toUpperCase() === ALL_SCOPE) return ALL_SCOPE;
  if (isDerivedDateGroupId(id)) return id.toUpperCase();
  if (authored.some((g) => g.id === id)) return id;
  return null;
}

/** The display grammar for the specific-dates text, chosen from the roster's span.
 *  This is a *display* choice only — every token still resolves back to the
 *  full-ISO `it.id`. Single-month rosters keep bare `DD` (the common case, and the
 *  pre-fix behavior); multi-month rosters qualify by month so two dates that share
 *  a day-of-month no longer collide. */
type DateTextFormat = "day" | "monthday" | "iso";

function detectFormat(dateItems: DateScopeItem[]): DateTextFormat {
  const years = new Set<string>();
  const months = new Set<string>();
  for (const it of dateItems) {
    years.add(it.id.slice(0, 4));
    months.add(it.id.slice(0, 7));
  }
  if (years.size > 1) return "iso";
  if (months.size > 1) return "monthday";
  return "day";
}

/** Render a full-ISO id as a token in the chosen grammar. */
function tokenFor(id: string, format: DateTextFormat): string {
  if (format === "iso") return id; // YYYY-MM-DD
  if (format === "monthday") return id.slice(5); // MM-DD
  return String(Number(id.slice(8, 10))); // bare DD, no leading zero
}

function sameRefs(a: readonly DateRef[], b: readonly DateRef[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (String(a[i]) !== String(b[i])) return false;
  return true;
}

/** Compact concrete date refs into the "1, 5–8, 14" specific-dates text. Runs are
 *  compacted by chronological adjacency (index), with both endpoints rendered in the
 *  roster's grammar. Numeric or unknown refs are absent from `dateItems` and so
 *  contribute nothing (they are preserved in the value, not clobbered). */
export function refsToText(value: readonly DateRef[], dateItems: DateScopeItem[]): string {
  const format = detectFormat(dateItems);
  const indexById = new Map(dateItems.map((it, index) => [it.id, index]));
  const picked = value
    .map((id) => {
      const index = indexById.get(String(id));
      return index === undefined ? undefined : { index, id: String(id) };
    })
    .filter((x): x is { index: number; id: string } => x !== undefined)
    .sort((a, b) => a.index - b.index);
  if (picked.length === 0) return "";
  const parts: string[] = [];
  let runStart = picked[0];
  let prev = picked[0];
  for (let i = 1; i <= picked.length; i += 1) {
    const cur = picked[i];
    const contiguous = cur && cur.index === prev.index + 1;
    if (!contiguous) {
      parts.push(
        runStart === prev
          ? tokenFor(runStart.id, format)
          : `${tokenFor(runStart.id, format)}–${tokenFor(prev.id, format)}`,
      );
      if (cur) runStart = cur;
    }
    if (cur) prev = cur;
  }
  return parts.join(", ");
}

/** Parse the specific-dates text into concrete date refs from the range. Tokens
 *  resolve full-ISO → `MM-DD` → bare `DD` against the roster, always keying on the
 *  full-ISO `it.id` — never first-wins across months. Ambiguous shorter forms
 *  (e.g. a bare day that occurs in two months) resolve to null and are dropped. */
export function textToRefs(text: string, dateItems: DateScopeItem[]): string[] {
  const format = detectFormat(dateItems);
  const indexById = new Map(dateItems.map((it, i) => [it.id, i]));
  const byIso = new Map<string, string>();
  const byMonthDay = new Map<string, string | null>();
  const byDay = new Map<number, string | null>();
  for (const it of dateItems) {
    byIso.set(it.id, it.id);
    const md = it.id.slice(5);
    byMonthDay.set(md, byMonthDay.has(md) ? null : it.id);
    const day = Number(it.id.slice(8, 10));
    byDay.set(day, byDay.has(day) ? null : it.id);
  }
  const resolveSingle = (tok: string): string | undefined => {
    const t = tok.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return byIso.get(t);
    if (/^\d{2}-\d{2}$/.test(t)) return byMonthDay.get(t) ?? undefined;
    if (/^\d{1,2}$/.test(t)) return byDay.get(Number(t)) ?? undefined;
    return undefined;
  };
  const seen = new Set<string>();
  const refs: string[] = [];
  const addId = (id: string | undefined) => {
    if (id && !seen.has(id)) {
      seen.add(id);
      refs.push(id);
    }
  };
  for (const raw of text.split(",")) {
    const token = raw.trim();
    if (token === "") continue;
    if (format === "day") {
      // Single-month grammar: bare days, ranges via any dash (pre-fix behavior).
      const norm = token.replace(/[–—]/g, "-");
      const range = norm.match(/^(\d{1,2})-(\d{1,2})$/);
      if (range) {
        const lo = Number(range[1]);
        const hi = Number(range[2]);
        for (let d = Math.min(lo, hi); d <= Math.max(lo, hi); d += 1)
          addId(byDay.get(d) ?? undefined);
      } else if (/^\d{1,2}$/.test(norm)) {
        addId(byDay.get(Number(norm)) ?? undefined);
      }
      continue;
    }
    // Month-aware grammar: ranges split on en/em-dash (or a spaced hyphen) so the
    // hyphens inside MM-DD / YYYY-MM-DD tokens are not mistaken for a range.
    const ends = token.split(/\s*[–—]\s*|\s+-\s+/);
    if (ends.length === 2) {
      const loId = resolveSingle(ends[0]);
      const hiId = resolveSingle(ends[1]);
      if (loId !== undefined && hiId !== undefined) {
        let i = indexById.get(loId) ?? 0;
        let j = indexById.get(hiId) ?? 0;
        if (i > j) [i, j] = [j, i];
        for (let k = i; k <= j; k += 1) addId(dateItems[k].id);
      }
    } else {
      addId(resolveSingle(token));
    }
  }
  // Preserve chronological order regardless of how the text was typed.
  return refs.sort((a, b) => (indexById.get(a) ?? 0) - (indexById.get(b) ?? 0));
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
  allValue = [],
}: DateScopeFieldProps) {
  const scope = activeScope(value, dateGroups);
  // Custom text is kept distinct from the chips: it shows only when the value is
  // concrete dates (no scope active). Seeded from the value on mount.
  const isCustom = scope === null;
  const [text, setText] = React.useState(() => (isCustom ? refsToText(value, dateItems) : ""));
  // The refs this field last emitted from its own `onCustom`. Used to distinguish
  // the field's own round-trip (including a partial token that transiently parses
  // to `[]` mid-typing) from a GENUINE external `value` change. `null` means "no
  // pending self-emit" (mount, or after a scope pick), so the effect re-seeds.
  const lastEmittedRef = React.useRef<readonly DateRef[] | null>(null);

  // Re-sync `text` on GENUINE external `value` changes only (a consumer loading a
  // new card, switching scope, undo/redo) so the field can't desync. If `value`
  // equals the refs we just emitted, this is our own round-trip — leave the text
  // as typed (an empty `[]` is a valid emitted value, so partial-token typing that
  // transiently parses to `[]` is NOT clobbered). A value that is a scope (not
  // custom) clears the text.
  React.useEffect(() => {
    if (lastEmittedRef.current !== null && sameRefs(value, lastEmittedRef.current)) return;
    lastEmittedRef.current = null;
    setText(isCustom ? refsToText(value, dateItems) : "");
  }, [value, dateItems, isCustom]);

  const selectScope = (id: string) => {
    // A scope pick is not a custom round-trip; clear the marker so the effect
    // re-seeds text to "" for the scope value.
    lastEmittedRef.current = null;
    setText("");
    onChange(id.toUpperCase() === ALL_SCOPE ? [...allValue] : [id]);
  };

  const onCustom = (next: string) => {
    const refs = textToRefs(next, dateItems);
    lastEmittedRef.current = refs;
    setText(next);
    onChange(refs);
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
