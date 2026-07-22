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
import { FaCircleInfo } from "@/components/icons";

/**
 * A concrete member id inside the coefficient domain. Members are compared with
 * EXACT typed identity (`Set.has`), so a numeric shift id `1` and a string shift
 * id `"1"` never collapse — matching the backend's typed group expansion (M1).
 */
export type CoefficientMemberId = number | string;

/** One coefficient-domain entity. A coefficient SOURCE id is always a string (the
 *  persisted `CoefficientEntry` / `ShiftTypeRef` is string-only), so numeric shift
 *  items are never modelled as items here — they only ever appear as typed group
 *  `members`. */
export interface CoefficientEntity {
  id: string;
}

/** One coefficient-domain group; `members` are the concrete member ids it expands
 *  to, kept at their AUTHORED type (numeric stays numeric) so expansion/coverage/
 *  overlap match the backend exactly (M1). */
export interface CoefficientGroup {
  id: string;
  members: readonly CoefficientMemberId[];
}

/** The full domain a coefficient sub-editor operates over — every authored item
 *  and group, INCLUDING synthetic/reserved rows (e.g. Counts' OFF/LEAVE items and
 *  ALL group) when the consumer wants them coefficient-eligible. */
export interface CoefficientDomain {
  items: readonly CoefficientEntity[];
  groups: readonly CoefficientGroup[];
}

/** A draft coefficient value: a positive integer, `""` (blank, dropped on save), or
 *  a raw invalid string kept verbatim (mirrors EDGE-PR-10's clamp-vs-validate split). */
export type CoefficientDraftValue = number | string;

/** A `[id, value]` pair — the draft form of the persisted `CoefficientEntry`. */
export type CoefficientPair = [string, CoefficientDraftValue];

function expandedIdsById(domain: CoefficientDomain): Map<string, readonly CoefficientMemberId[]> {
  const map = new Map<string, readonly CoefficientMemberId[]>();
  for (const item of domain.items) map.set(item.id, [item.id]);
  for (const group of domain.groups) map.set(group.id, [...new Set(group.members)]);
  return map;
}

/** Canonical entry order: authored items, then groups, each in authoring order
 *  (FR-PR-54 / the historical `entityOrdering.getOrderedEntries`). */
export function coefficientEntryOrder(domain: CoefficientDomain): string[] {
  return [...domain.items.map((i) => i.id), ...domain.groups.map((g) => g.id)];
}

/** Sort `ids` into canonical entry order; an id absent from the domain sorts last,
 *  in its original relative order (stable). */
export function sortIdsByEntryOrder(ids: readonly string[], domain: CoefficientDomain): string[] {
  const order = new Map(coefficientEntryOrder(domain).map((id, index) => [id, index]));
  return [...ids].sort(
    (a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER),
  );
}

/**
 * Eligible coefficient ids (FR-PR-70): every item whose id is in the expanded
 * selection, plus every non-empty group whose members are ALL in the expanded
 * selection — in canonical entry order (EDGE-PR-11).
 */
export function eligibleCoefficientIds(
  selection: readonly string[],
  domain: CoefficientDomain,
): string[] {
  const expanded = expandedIdsById(domain);
  const selectedExpanded = new Set<CoefficientMemberId>(
    selection.flatMap((id) => expanded.get(id) ?? []),
  );
  return [
    // Only string item ids are coefficient SOURCES; a numeric member reached via a
    // group is covered for group-eligibility but never returned/persisted itself.
    ...domain.items.filter((item) => selectedExpanded.has(item.id)).map((item) => item.id),
    ...domain.groups
      .filter((g) => g.members.length > 0 && g.members.every((m) => selectedExpanded.has(m)))
      .map((g) => g.id),
  ];
}

/** Read one id's current draft value, defaulting to blank. */
export function coefficientValueFor(
  pairs: readonly CoefficientPair[],
  id: string,
): CoefficientDraftValue {
  return pairs.find(([pid]) => pid === id)?.[1] ?? "";
}

/**
 * Re-sync the draft pairs to the currently-eligible ids (FR-PR-73): drop ids no
 * longer eligible, add blank pairs for newly-eligible ones, and preserve every
 * other id's value untouched — in canonical entry order.
 */
export function syncCoefficientPairs(
  selection: readonly string[],
  pairs: readonly CoefficientPair[],
  domain: CoefficientDomain,
): CoefficientPair[] {
  return eligibleCoefficientIds(selection, domain).map(
    (id): CoefficientPair => [id, coefficientValueFor(pairs, id)],
  );
}

/**
 * Parse+clamp one coefficient input on change (FR-PR-72/EDGE-PR-10): blank stays
 * blank; a `NaN` parse keeps the raw text; otherwise `Math.max(1, parsedInt)` — so
 * `1.5`/`2.9` truncate to `1`/`2` via `Number.parseInt` and values below 1 clamp up.
 */
export function parseCoefficientInput(raw: string): CoefficientDraftValue {
  if (raw === "") return "";
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? raw : Math.max(1, parsed);
}

/** Rewrite exactly one id's value, preserving every other eligible id's value. */
export function updateCoefficientPair(
  eligibleIds: readonly string[],
  pairs: readonly CoefficientPair[],
  id: string,
  value: CoefficientDraftValue,
): CoefficientPair[] {
  return eligibleIds.map(
    (eid): CoefficientPair => [eid, eid === id ? value : coefficientValueFor(pairs, eid)],
  );
}

/** The verbatim per-id integer error (spec 05 coefficient validation table). */
export function coefficientIntegerErrorMessage(id: string): string {
  return `Coefficient for ${id} must be an integer of at least 1`;
}

/** The verbatim overlap error (spec 05 coefficient validation table). */
export function coefficientOverlapMessage(
  sourceA: string,
  sourceB: string,
  sharedId: CoefficientMemberId,
): string {
  return `Shift type coefficients overlap: ${sourceA}, ${sourceB} include ${sharedId}`;
}

function findCoefficientOverlap(
  entries: readonly [string, number][],
  domain: CoefficientDomain,
): string | undefined {
  const expanded = expandedIdsById(domain);
  const sourceByExpandedId = new Map<CoefficientMemberId, string>();
  for (const [id] of entries) {
    for (const expandedId of expanded.get(id) ?? []) {
      const existing = sourceByExpandedId.get(expandedId);
      if (existing !== undefined) return coefficientOverlapMessage(existing, id, expandedId);
      sourceByExpandedId.set(expandedId, id);
    }
  }
  return undefined;
}

export interface CoefficientValidation {
  /** The `[id, coefficient]` entries to persist — populated only when there are no
   *  per-id errors (blank entries are dropped, per FR-PR-74). */
  entries: Array<[string, number]>;
  /** Per-id integer errors, keyed by id. */
  errorsById: Record<string, string>;
  /** Set only when every id parses cleanly AND two sources still overlap (per-id
   *  errors take precedence over the overlap check — spec 05 coefficient table). */
  overlapError?: string;
}

/**
 * Validate + build the persisted `[id, coefficient]` entries. Syncs to the
 * currently-eligible ids first (so a stale id from a prior selection can never
 * leak into the saved array), then applies the per-id integer rule; the overlap
 * check runs only when every remaining (non-blank) value is already valid.
 */
export function validateCoefficientPairs(
  selection: readonly string[],
  pairs: readonly CoefficientPair[],
  domain: CoefficientDomain,
): CoefficientValidation {
  const synced = syncCoefficientPairs(selection, pairs, domain);
  const errorsById: Record<string, string> = {};
  for (const [id, value] of synced) {
    if (value === "") continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      errorsById[id] = coefficientIntegerErrorMessage(id);
    }
  }
  if (Object.keys(errorsById).length > 0) return { entries: [], errorsById };
  const entries = synced.filter((pair): pair is [string, number] => pair[1] !== "");
  return { entries, errorsById, overlapError: findCoefficientOverlap(entries, domain) };
}

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
  /** Explanatory note shown under the heading (per-mode coverage-value / count copy). */
  note?: string;
  /** Show the "All N have a coefficient" / "N need a coefficient" strip (default true). */
  showCoverage?: boolean;
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
  note,
  showCoverage = true,
  testId = "coefficient-fields",
}: CoefficientFieldsProps) {
  const eligible = React.useMemo(
    () => eligibleCoefficientIds(selection, domain),
    [selection, domain],
  );

  if (eligible.length === 0) {
    return (
      <p className="text-meta italic text-ink3" data-testid={`${testId}-empty`}>
        Coefficients are not needed when no {label.toLowerCase()} is selected.
      </p>
    );
  }

  const filledCount = eligible.filter((id) => {
    const value = coefficientValueFor(pairs, id);
    return value !== "" && typeof value === "number";
  }).length;
  const allFilled = filledCount === eligible.length;
  const missing = eligible.length - filledCount;

  return (
    <div className="flex flex-col gap-3 border border-line2 bg-panel p-3.5" data-testid={testId}>
      <span className="text-label font-semibold uppercase tracking-[0.03em] text-ink2">
        {label} Coefficients
      </span>
      {note && (
        <p className="flex items-start gap-2 text-meta text-ink3" data-testid={`${testId}-note`}>
          <FaCircleInfo className="mt-0.5 flex-none text-brandink" />
          <span>{note}</span>
        </p>
      )}
      {showCoverage && (
        <div
          className={`flex items-center gap-2 border px-3 py-2 text-meta font-semibold ${
            allFilled
              ? "border-success bg-successtint text-success"
              : "border-warn bg-warntint text-warn"
          }`}
          data-testid={`${testId}-coverage`}
        >
          {allFilled
            ? `All ${eligible.length} ${eligible.length === 1 ? "type has" : "types have"} a coefficient`
            : `${missing} ${missing === 1 ? "type needs" : "types need"} a coefficient`}
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        {eligible.map((id) => {
          const value = coefficientValueFor(pairs, id);
          const err = errorsById[id];
          return (
            <label key={id} className="flex flex-col gap-1">
              <span className="truncate text-label font-semibold text-ink3" title={id}>
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
                className="h-9 w-24 font-mono"
              />
              {err && <span className="text-meta font-semibold text-error">{err}</span>}
            </label>
          );
        })}
      </div>
      {aggregateError && (
        <p
          className="text-meta font-semibold text-error"
          role="alert"
          data-testid={`${testId}-aggregate-error`}
        >
          {aggregateError}
        </p>
      )}
    </div>
  );
}
