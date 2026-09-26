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
  CoefficientDerivation,
  CoefficientDomain,
  CoefficientPair,
} from "@/components/card-editor/coefficient-fields";
import { LEAVE_CREDIT_HALF_HOURS } from "./half-hour-codec";

/** Minutes represented by one half-hour grid step — the derivation divisor. */
const MINUTES_PER_HALF_HOUR = 30;

/**
 * The half-hour coefficient a source derives from its WORKING TIME in minutes, or
 * `null` when it is non-derivable. `LEAVE` derives the default paid-leave credit
 * (not a worked duration); a worked source derives `minutes / 30` ONLY when the
 * duration is present, positive, and a whole multiple of 30 — an off-grid duration
 * is non-derivable, NEVER rounded. The single source of truth for derivation,
 * shared by {@link buildContractedCoefficientDomain} (row hints) and the Refresh
 * preview (`refresh-model.ts`).
 */
export function deriveCoefficientHalfHours(id: string, minutes: number | undefined): number | null {
  if (id === RESERVED_SHIFT_TYPE.leave) return LEAVE_CREDIT_HALF_HOURS;
  if (minutes == null || !Number.isInteger(minutes) || minutes <= 0) return null;
  if (minutes % MINUTES_PER_HALF_HOUR !== 0) return null;
  return minutes / MINUTES_PER_HALF_HOUR;
}

/**
 * The working-time derivation a coefficient-row hint is built from, or `undefined`
 * when the source is non-derivable (no working time, or off the half-hour grid).
 * Read through {@link deriveCoefficientHalfHours} so the minutes shown and the
 * coefficient derived are the same value, never two that can disagree.
 */
function derivationFor(
  id: string,
  durationById: Map<string, number | undefined>,
): CoefficientDerivation | undefined {
  const halfHours = deriveCoefficientHalfHours(id, durationById.get(id));
  return halfHours === null
    ? undefined
    : { minutes: halfHours * MINUTES_PER_HALF_HOUR, credit: id === RESERVED_SHIFT_TYPE.leave };
}

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
  state: Pick<ScenarioUiState, "shifts" | "shiftGroups">,
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
  // Working time per source, so each row can carry the derivation its hint reads.
  const durationById = new Map<string, number | undefined>();
  for (const shift of state.shifts) {
    if (typeof shift.id === "string") durationById.set(shift.id, shift.durationMinutes);
  }
  const items = leafSources
    .filter((id) => {
      const indices = expandShiftTypeSelector(id, map);
      return indices != null && indices.length === 1 && expanded.has(indices[0]);
    })
    .map((id) => {
      const derivation = derivationFor(id, durationById);
      return derivation ? { id, derivation } : { id };
    });
  return { items, groups: [] };
}

/** The concrete coefficient ids of a contracted domain (its `items`, in order) —
 *  the `selection` a `CoefficientFields` fed that domain must receive. */
export function contractedCoefficientIds(domain: CoefficientDomain): string[] {
  return domain.items.map((item) => item.id);
}
