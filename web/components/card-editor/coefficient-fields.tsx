"use client";

// Shared per-shift-type coefficient sub-editor (T12 seed) — extracted from the
// Counts editor so Requirements (staffing multiplier) and later Contracted Hours
// (derived half-hours) reuse the exact eligibility/sync/validate contract. Ground
// truth is the historical countShiftTypeCoefficients.ts +
// CountShiftTypeCoefficientFields.tsx (spec 05 FR-PR-70..74, EDGE-PR-10/11); this
// file mirrors that behavior 1:1, generalized behind a domain-agnostic `id: string`
// shape so it is not Counts-specific.
//
// Eligibility (FR-PR-70) is structural, not curated: every domain "item" whose own
// id is reachable from the expanded selection, PLUS every non-empty "group" whose
// members are ALL reachable — in canonical entry order (items, then groups, each in
// authoring order). A group and its members can therefore BOTH be eligible at once
// (e.g. selecting a group alone makes both the group id and each of its member ids
// eligible) — that duplication is exactly what the overlap check below exists to
// catch once the user has entered a value for two overlapping sources.

import * as React from "react";
import { Input } from "@/components/ui/input";
import { Surface } from "@/components/ui/surface";
import { FaCircleInfo } from "@/components/icons";
import {
  coefficientValueFor,
  derivedCoefficientHintText,
  eligibleCoefficientIds,
  parseCoefficientInput,
  updateCoefficientPair,
  type CoefficientDomain,
  type CoefficientPair,
} from "./coefficient-model";

export {
  coefficientEntryOrder,
  coefficientIntegerErrorMessage,
  coefficientOverlapMessage,
  coefficientValueFor,
  derivedCoefficientHintText,
  eligibleCoefficientIds,
  parseCoefficientInput,
  sortIdsByEntryOrder,
  syncCoefficientPairs,
  updateCoefficientPair,
  validateCoefficientPairs,
  type CoefficientDerivation,
  type CoefficientDomain,
  type CoefficientDraftValue,
  type CoefficientEntity,
  type CoefficientGroup,
  type CoefficientMemberId,
  type CoefficientPair,
  type CoefficientValidation,
} from "./coefficient-model";

export interface CoefficientFieldsProps {
  /** The current (unexpanded) selection driving eligibility — the raw ids/groups
   *  chosen in the owning multi-select (e.g. Count Shift Types). */
  selection: readonly string[];
  /** The draft coefficient pairs; the component re-derives eligibility itself, so
   *  passing an un-synced `pairs` (e.g. straight from a loaded card) is safe. */
  pairs: readonly CoefficientPair[];
  domain: CoefficientDomain;
  onChange: (next: CoefficientPair[], changedId: string) => void;
  /** Per-id error messages, e.g. from `validateCoefficientPairs().errorsById`. */
  errorsById?: Record<string, string>;
  /**
   * A whole-control error not tied to a single id — the overlap message
   * (`validateCoefficientPairs().overlapError`). Generic on purpose: Requirements
   * and M2 reuse the same slot, so no consumer needs a local workaround (M2).
   */
  aggregateError?: string;
  /** e.g. `"Count Shift Type"` / `"Shift Type"` — feeds the heading + empty copy. */
  label?: string;
  /** Optional heading override where `<label> Coefficients` is not the right title —
   *  the guided Contracted Hours form heads its block "Derived coefficients ·
   *  half-hours" (ScreenCards.dc.html:813) because those coefficients are working
   *  time derived, not a count. Absent ⇒ the composed default. */
  heading?: string;
  /** Explanatory note shown under the heading (per-mode coverage-value / count copy). */
  note?: string;
  /** Show the "All N have a coefficient" / "N need a coefficient" strip (default true). */
  showCoverage?: boolean;
  /** Show a per-row working-time hint from each entity's `derivation` — the guided
   *  Contracted Hours rows (ScreenCards). A derivable source reads its working time;
   *  a non-derivable one reads the set-by-hand message. Off ⇒ no hint (the default,
   *  for a generic count / requirement domain whose items carry no `derivation`). */
  derivedHints?: boolean;
  testId?: string;
}

export function CoefficientFields({
  selection,
  pairs,
  domain,
  onChange,
  errorsById = {},
  aggregateError,
  label = "Coefficient",
  heading,
  note,
  showCoverage = true,
  derivedHints = false,
  testId = "coefficient-fields",
}: CoefficientFieldsProps) {
  const eligible = React.useMemo(
    () => eligibleCoefficientIds(selection, domain),
    [selection, domain],
  );
  const entityById = React.useMemo(
    () => new Map(domain.items.map((item) => [item.id, item])),
    [domain],
  );

  const filledCount = eligible.filter((id) => {
    const value = coefficientValueFor(pairs, id);
    return value !== "" && typeof value === "number";
  }).length;
  const allFilled = filledCount === eligible.length;
  const missing = eligible.length - filledCount;
  const hasEligible = eligible.length > 0;

  // One panel whose BODY is conditional — the prototype's shape: `coefEmpty` and
  // `coefRows` are sibling branches inside a single container and `unitNote` closes
  // it either way (ScreenCards.dc.html:325-352). The panel therefore stays mounted
  // with nothing selected, so picking a shift type fills the rows in place rather
  // than making a whole panel appear.
  return (
    <Surface
      level="well"
      geometry="control"
      className="flex flex-col gap-3 p-3.5"
      data-testid={testId}
    >
      <span className="text-label font-semibold uppercase tracking-[0.03em] text-ink2">
        {heading ?? `${label} Coefficients`}
      </span>
      {!hasEligible && (
        <p className="text-meta italic text-ink3" data-testid={`${testId}-empty`}>
          Coefficients are not needed when no {label.toLowerCase()} is selected.
        </p>
      )}
      {hasEligible && showCoverage && (
        <div
          className={`flex items-center gap-2 rounded-control border px-3 py-2 text-meta font-semibold ${
            allFilled
              ? "border-success bg-successtint text-successink"
              : "border-warn bg-warntint text-warnink"
          }`}
          data-testid={`${testId}-coverage`}
        >
          {allFilled
            ? `All ${eligible.length} ${eligible.length === 1 ? "type has" : "types have"} a coefficient`
            : `${missing} ${missing === 1 ? "type needs" : "types need"} a coefficient`}
        </div>
      )}
      {/* One row per eligible id: a fixed-width id tag, the value, then the row's
          message slot — the prototype's coefficient rows (ScreenCards.dc.html:341-350).
          Stacked rows keep the ids left-aligned and readable; a wrapping grid of
          label-over-input columns loses that column and stretches the inputs. */}
      <div className="flex flex-col gap-2 empty:hidden">
        {eligible.map((id) => {
          const value = coefficientValueFor(pairs, id);
          const err = errorsById[id];
          const hint = derivedHints
            ? derivedCoefficientHintText(entityById.get(id)?.derivation)
            : undefined;
          return (
            <label key={id} className="flex flex-wrap items-center gap-3">
              <span
                className="min-w-[66px] rounded-chip border border-line2 bg-surface px-2.5 py-[5px] text-center font-mono text-label font-semibold text-ink"
                title={id}
              >
                {id}
              </span>
              <Input
                type="number"
                min={1}
                step={1}
                data-testid={`${testId}-input-${id}`}
                aria-label={`Coefficient for ${id}`}
                value={value}
                onChange={(e) => {
                  const parsed = parseCoefficientInput(e.target.value);
                  onChange(updateCoefficientPair(eligible, pairs, id, parsed), id);
                }}
                placeholder="—"
                className="w-[88px] px-2.5 font-mono font-bold"
              />
              {hint && (
                <span
                  className="font-mono text-label font-medium text-ink3"
                  data-testid={`${testId}-hint-${id}`}
                >
                  {hint}
                </span>
              )}
              {err && <span className="text-meta font-semibold text-error">{err}</span>}
            </label>
          );
        })}
      </div>
      {/* The explainer closes the panel in the prototype (`unitNote`, margin-top 11px),
          after the rows it describes — not between the heading and the controls. */}
      {note && (
        <p className="flex items-start gap-2 text-meta text-ink3" data-testid={`${testId}-note`}>
          <FaCircleInfo className="mt-0.5 flex-none text-ink3" />
          <span>{note}</span>
        </p>
      )}
      {aggregateError && (
        <p
          className="text-meta font-semibold text-error"
          role="alert"
          data-testid={`${testId}-aggregate-error`}
        >
          {aggregateError}
        </p>
      )}
    </Surface>
  );
}
