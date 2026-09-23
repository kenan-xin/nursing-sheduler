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
import { Button } from "@/components/ui/button";
import { FaCircleExclamation } from "@/components/icons";
import { formatWeight, parseWeightInput, type WeightFieldValue } from "./weight-value";

export {
  formatWeight,
  isValidWeightValue,
  isWeightNonPositive,
  parseWeightInput,
  type WeightFieldValue,
} from "./weight-value";

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
          className="font-mono"
        />
        <Button
          variant="outline"
          data-testid={`${testId}-plus-inf`}
          title="Set to positive infinity (∞)"
          onClick={() => onChange(Infinity)}
          className="font-mono"
        >
          +∞
        </Button>
        <Button
          variant="outline"
          data-testid={`${testId}-minus-inf`}
          title="Set to negative infinity (-∞)"
          onClick={() => onChange(-Infinity)}
          className="font-mono"
        >
          −∞
        </Button>
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
 *
 * Each tone pairs its tint with the matching semantic INK rather than the base
 * tier (DESIGN.md §5 Badges / the Redundant Signal Rule). The two coincide for
 * success and warn in light mode but diverge for error in both themes and for all
 * three in dark, so `text-success` on `--successtint` was a status carried by
 * colour alone the moment the theme flipped.
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
    success: "border-success bg-successtint text-successink",
    error: "border-error bg-errortint text-errorink",
    warn: "border-warn bg-warntint text-warnink",
    neutral: "border-line2 bg-panel text-ink2",
  }[tone];
  return (
    <span
      data-testid="weight-pill"
      className={`inline-flex items-center whitespace-nowrap rounded-chip border px-2.5 py-1 font-mono text-label font-semibold tracking-[0.03em] ${toneClass} ${className ?? ""}`}
    >
      WEIGHT {label}
    </span>
  );
}
