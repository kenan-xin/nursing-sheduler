// Shared low-level Contracted-Hours domain primitives (qq0.23c cycle-free
// fixup). `contracted-model.ts` (guided authoring + card build) and
// `refresh-model.ts` (Refresh preview/apply) both depend downward on this
// module for the draft shape and the CONCRETE coefficient-domain expansion,
// so neither imports a runtime value from the other. Nothing here depends on
// either sibling module.

import {
  buildShiftTypeIndexMap,
  expandShiftTypeSelector,
  RESERVED_SHIFT_TYPE,
  type DateRef,
  type PersonRef,
  type ScenarioUiState,
  type ShiftTypeRef,
} from "@/lib/scenario";
import type {
  CoefficientDomain,
  CoefficientPair,
} from "@/components/card-editor/coefficient-fields";

/** The flat draft the guided contracted form edits. Target values are held as the
 *  human hours STRINGS the author types (e.g. "160h", "8h 30m") and converted to
 *  integer half-hours via the codec on build; expression/weight are derived from
 *  `policy`, never free draft fields. */
export interface ContractedFormState {
  description: string;
  person: PersonRef[];
  countDates: DateRef[];
  countShiftTypes: ShiftTypeRef[];
  countShiftTypeCoefficients: CoefficientPair[];
  policy: "exact" | "range";
  /** Exact-policy target as authored (human hours). */
  targetExact: string;
  /** Range-policy minimum target as authored (human hours). */
  targetRangeMin: string;
  /** Range-policy maximum target as authored (human hours). */
  targetRangeMax: string;
}

/**
 * The CONCRETE coefficient domain for a contracted-hours draft — the exact
 * day-state set the coverage bijection is defined over. Unlike the M1
 * `buildCountShiftTypeDomain` (which deliberately makes a selected GROUP/`ALL`
 * id itself coefficient-eligible), this expands the selected `countShiftTypes`
 * under BACKEND semantics ({@link buildShiftTypeIndexMap}) and returns ONLY the
 * concrete leaf sources — authored STRING shift ids plus `LEAVE` when reached,
 * never a group/`ALL`, and `OFF` excluded — as `items` with `groups: []`.
 * Feeding this (with its own {@link contractedCoefficientIds} as the
 * `selection`) to `CoefficientFields` makes its eligibility, coverage strip,
 * and `syncCoefficientPairs` line up 1:1 with `validateContractedHoursContract`.
 * A malformed scenario map yields an empty domain — the commit gate surfaces
 * the map error separately rather than throwing here.
 */
export function buildContractedCoefficientDomain(
  state: ScenarioUiState,
  selection: readonly ShiftTypeRef[],
): CoefficientDomain {
  let map: ReturnType<typeof buildShiftTypeIndexMap>;
  try {
    map = buildShiftTypeIndexMap(state.shifts, state.shiftGroups);
  } catch {
    return { items: [], groups: [] };
  }
  // Expand the selectors to concrete day-state indices, exactly as the validator's
  // coverage check does — a group/`ALL` selector contributes its member indices.
  const expanded = new Set<number>();
  for (const selector of selection) {
    const indices = expandShiftTypeSelector(selector, map);
    if (indices) for (const s of indices) expanded.add(s);
  }
  // Candidate concrete leaf SOURCES, in canonical order: authored string shift ids
  // (a numeric shift id can never be a coefficient source), then `LEAVE`. `OFF` is
  // never a valid contracted coefficient, so it is excluded even when reached.
  const leafSources: string[] = [
    ...state.shifts.filter((s) => typeof s.id === "string").map((s) => s.id as string),
    RESERVED_SHIFT_TYPE.leave,
  ];
  const items = leafSources
    .filter((id) => {
      const indices = expandShiftTypeSelector(id, map);
      return indices != null && indices.length === 1 && expanded.has(indices[0]);
    })
    .map((id) => ({ id }));
  return { items, groups: [] };
}

/** The concrete coefficient ids of a contracted domain (its `items`, in order) —
 *  the `selection` a `CoefficientFields` fed that domain must receive. */
export function contractedCoefficientIds(domain: CoefficientDomain): string[] {
  return domain.items.map((item) => item.id);
}
