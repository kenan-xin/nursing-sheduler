"use client";

// Shared soft/hard weight dial (T12 seed) — extracted from the Counts editor so
// Requirements/Successions/Affinities clone the same control (spec 05 FR-PR-16..18,
// C3 CON-SEM weight semantics). Ground truth for the parsing/validation contract is
// the historical WeightInput/numberParsing.ts (parseWeightValue, isValidWeightValue,
// isWeightNonPositive, getWeightWithPositivePrefix) — this file mirrors that
// behavior 1:1, generalized behind a fully-controlled component so every consumer
// shares one soft/hard dial and one card weight pill.
//
// The value type is `number | string`: a valid weight is always a `number` (a
// finite value, or exactly JS Infinity/-Infinity — both are `number`s, so the
// Weight model type (lib/scenario/types.ts) already covers them). A `string` is
// the RAW, not-yet-valid text the user is mid-typing (e.g. "-" before a digit, or
// an unparseable "abc") — kept verbatim so a keystroke is never eaten; validation
// at Save time is what turns an unparsed string into the verbatim error message.

import * as React from "react";
import { Input } from "@/components/ui/input";
import { FaCircleExclamation } from "@/components/icons";

/** A weight field's value — see the file header for the `number | string` contract. */
export type WeightFieldValue = number | string;

const INFINITY_TOKENS = ["∞", "+∞", "inf", "+inf", "infinity", "+infinity"];
const NEG_INFINITY_TOKENS = ["-∞", "-inf", "-infinity"];
const SUFFIX_MULTIPLIERS: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };

/**
 * Parse raw weight text exactly like the historical `parseWeightValue`:
 * case-insensitive infinity spellings; a numeric string with a k/m/b/t suffix is
 * multiplied and, when the result is an integer, rounded to that integer
 * (otherwise the raw text is kept); otherwise `parseInt` is applied and, on `NaN`,
 * the raw text is kept (EDGE-PR-09).
 */
export function parseWeightInput(raw: string): WeightFieldValue {
  const lower = raw.toLowerCase();
  if (INFINITY_TOKENS.includes(lower)) return Infinity;
  if (NEG_INFINITY_TOKENS.includes(lower)) return -Infinity;
  const suffix = raw.match(/^([+-]?\d+(?:\.\d+)?)([kmbt])$/i);
  if (suffix) {
    const multiplier = SUFFIX_MULTIPLIERS[suffix[2].toLowerCase()];
    const result = Number.parseFloat(suffix[1]) * multiplier;
    return Number.isInteger(result) ? Math.round(result) : raw;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? raw : parsed;
}

/** Whether a weight value is valid: a finite number or exactly `Infinity`/`-Infinity`
 *  — any raw (unparsed) string is invalid (`isValidWeightValue` ground truth). */
export function isValidWeightValue(value: WeightFieldValue): value is number {
  return typeof value === "number" && (Number.isFinite(value) || Math.abs(value) === Infinity);
}

/** Whether a valid numeric weight is `<= 0` (`isWeightNonPositive` ground truth). */
export function isWeightNonPositive(value: number): boolean {
  return value <= 0;
}

/**
 * Format a valid weight for display: a leading `+` on positive values (incl.
 * `+∞`), thousands separators via `toLocaleString` (which also renders the
 * infinities as `∞`/`-∞`). Mirrors `getWeightWithPositivePrefix`. An invalid
 * (string) draft renders as `Error` — callers should not normally reach this on a
 * saved card, only on a live invalid draft.
 */
export function formatWeight(value: WeightFieldValue): string {
  if (typeof value !== "number") return "Error";
  const text = value.toLocaleString();
  return value > 0 ? `+${text}` : text;
}

export interface WeightFieldProps {
  value: WeightFieldValue;
  onChange: (next: WeightFieldValue) => void;
  /** Default `"Weight (priority)"`. */
  label?: string;
  /** Default `"e.g. −50, +∞"` (spec 05 FR-PR-18 — Affinities overrides to positive examples). */
  placeholder?: string;
  /** Default: generic soft/hard explainer. */
  help?: string;
  error?: string;
  /**
   * When set, renders this italic note INSTEAD of the dial — the seam Requirements
   * needs for "Weight is not needed when the preferred number of people equals the
   * required number" (spec 05 FR-PR-24). No dial is mounted while a note is shown,
   * so no `WeightFieldValue` is read/written in that state.
   */
  note?: string;
  /** Root `data-testid` prefix (`<testId>-input`/`-plus-inf`/`-minus-inf`). */
  testId?: string;
}

const DEFAULT_HELP = "Positive encourages · negative discourages · ±∞ makes it a hard rule.";

export function WeightField({
  value,
  onChange,
  label = "Weight (priority)",
  placeholder = "e.g. −50, +∞",
  help = DEFAULT_HELP,
  error,
  note,
  testId = "weight-field",
}: WeightFieldProps) {
  if (note) {
    return (
      <div className="flex max-w-[420px] flex-col gap-1.5" data-testid={testId}>
        <span className="text-label font-semibold uppercase tracking-[0.03em] text-ink2">
          {label}
        </span>
        <p className="text-meta italic text-ink3">{note}</p>
      </div>
    );
  }
  return (
    <div className="flex max-w-[360px] flex-col gap-1.5" data-testid={testId}>
      <span className="text-label font-semibold uppercase tracking-[0.03em] text-ink2">
        {label}
      </span>
      <div className="flex gap-2">
        <Input
          data-testid={`${testId}-input`}
          aria-label={label}
          value={String(value)}
          onChange={(e) => onChange(parseWeightInput(e.target.value))}
          placeholder={placeholder}
          className="h-10 font-mono"
        />
        <button
          type="button"
          data-testid={`${testId}-plus-inf`}
          title="Set to positive infinity (∞)"
          onClick={() => onChange(Infinity)}
          className="h-10 flex-none border border-line px-3 font-mono text-label-md font-semibold hover:bg-panel"
        >
          +∞
        </button>
        <button
          type="button"
          data-testid={`${testId}-minus-inf`}
          title="Set to negative infinity (-∞)"
          onClick={() => onChange(-Infinity)}
          className="h-10 flex-none border border-line px-3 font-mono text-label-md font-semibold hover:bg-panel"
        >
          −∞
        </button>
      </div>
      <p className="text-meta text-ink3">{help}</p>
      {error && (
        <p className="flex items-center gap-1.5 text-meta font-semibold text-error" role="alert">
          <FaCircleExclamation className="size-3 flex-none" /> {error}
        </p>
      )}
    </div>
  );
}

export interface WeightPillProps {
  value: WeightFieldValue;
  className?: string;
}

/**
 * The card-summary weight pill — color-coded like the prototype `weightStyle`
 * (ScreenCards.dc.html): a positive weight (incl. `+∞`) is `success` (green), a
 * `-Infinity` is `error` (red), any other negative weight is `warn` (amber), and a
 * zero or invalid weight is neutral.
 */
export function WeightPill({ value, className }: WeightPillProps) {
  const label = formatWeight(value);
  const tone =
    typeof value !== "number"
      ? "neutral"
      : value === -Infinity
        ? "error"
        : value > 0
          ? "success"
          : value < 0
            ? "warn"
            : "neutral";
  const toneClass = {
    success: "border-success bg-successtint text-success",
    error: "border-error bg-errortint text-error",
    warn: "border-warn bg-warntint text-warn",
    neutral: "border-line2 bg-panel text-ink2",
  }[tone];
  return (
    <span
      data-testid="weight-pill"
      className={`inline-flex items-center whitespace-nowrap border px-2.5 py-1 font-mono text-label font-semibold tracking-[0.03em] ${toneClass} ${className ?? ""}`}
    >
      WEIGHT {label}
    </span>
  );
}
