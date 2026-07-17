// Refresh-from-Shift-Types derivation for the Contracted-Hours guided editor
// (T12 M2a-5, spec DL09 D6 / FR-CH-32 / AC-CH-09b). Two side-effect-free transforms
// behind the explicit "Refresh from Shift Types" action, kept out of the React shell
// so they are provable in the `node` vitest env:
//
//   • deriveContractedRefresh(form, state): compute a PREVIEW — for each CONCRETE
//     coefficient id in the current draft, derive the half-hour coefficient from the
//     Shift Type's working time (`durationMinutes / 30`, LEAVE → the default credit)
//     and categorize it against the draft's existing manual value. NEVER rounds (a
//     non-multiple-of-30 duration is non-derivable, not rounded) and NEVER mutates.
//   • applyContractedRefresh(form, preview): produce the draft the author gets when
//     they Confirm — set added/changed ids to their derived values, keep unchanged
//     and non-derivable ids at their existing manual value, drop removed ids.
//
// Nothing here runs automatically and nothing commits a scenario mutation: Confirm
// is an IN-DRAFT edit, and the only reversal is the form's own Cancel Edit (which
// discards the whole draft). There is deliberately NO granular Refresh-undo here.

import {
  buildShiftTypeIndexMap,
  expandShiftTypeSelector,
  RESERVED_SHIFT_TYPE,
  ShiftTypeMapError,
  type ScenarioUiState,
} from "@/lib/scenario";
import {
  coefficientValueFor,
  type CoefficientDraftValue,
  type CoefficientPair,
} from "@/components/card-editor/coefficient-fields";
import { LEAVE_CREDIT_HALF_HOURS } from "./half-hour-codec";
import {
  buildContractedCoefficientDomain,
  contractedCoefficientIds,
  type ContractedFormState,
} from "./contracted-model";

/** Minutes represented by one half-hour grid step — the derivation divisor. */
const MINUTES_PER_HALF_HOUR = 30;

/** How a concrete coefficient id compares to its Shift-Type-derived value:
 *  • `added`         — currently blank/absent; derivation yields a value.
 *  • `changed`       — currently has a value; the derived value differs.
 *  • `unchanged`     — currently has a value equal to the derived value.
 *  • `non-derivable` — worked id with no valid working time; its manual value is KEPT.
 *  • `removed`       — a stored coefficient no longer in the concrete id set (dropped). */
export type RefreshCategory = "added" | "changed" | "unchanged" | "non-derivable" | "removed";

/** One previewed coefficient row: what it is now, what the Shift Types imply, and
 *  which {@link RefreshCategory} bucket it falls in. `derived` is `null` exactly when
 *  the id is `non-derivable` or `removed` (no valid working time to derive from). */
export interface RefreshRow {
  id: string;
  category: RefreshCategory;
  /** The id's current draft value ("" when blank/absent). */
  current: CoefficientDraftValue;
  /** The value derived from the Shift Type, or `null` when non-derivable/removed. */
  derived: number | null;
}

/** The full, non-mutating preview a Refresh click computes. */
export interface RefreshPreview {
  rows: RefreshRow[];
  /** Selected STRING selectors that do not resolve to any concrete day-state
   *  (a stale/deleted id). Surfaced so the author sees the non-derivable selection
   *  to fix — INFORMATIONAL ONLY: they are never concrete coefficient sources, so
   *  {@link applyContractedRefresh} does not fabricate a coefficient for them (the
   *  commit validator remains the final gate on the unknown selector). */
  unresolved: string[];
}

/**
 * Derive one id's half-hour coefficient from Shift Type working time, or `null` when
 * it is non-derivable. `LEAVE` derives to the default paid-leave credit; a worked id
 * derives to `durationMinutes / 30` ONLY when the duration is present and a positive
 * multiple of 30 (so the result is a positive integer on the half-hour grid). A
 * missing or off-grid duration is non-derivable — never rounded.
 */
function deriveCoefficientValue(
  id: string,
  durationById: Map<string, number | undefined>,
): number | null {
  if (id === RESERVED_SHIFT_TYPE.leave) return LEAVE_CREDIT_HALF_HOURS;
  const duration = durationById.get(id);
  if (duration == null || !Number.isInteger(duration) || duration <= 0) return null;
  if (duration % MINUTES_PER_HALF_HOUR !== 0) return null;
  return duration / MINUTES_PER_HALF_HOUR;
}

/**
 * Compute the Refresh PREVIEW for a contracted draft over its CONCRETE coefficient
 * domain (the exact leaf day-state set the coverage bijection is defined over). Each
 * concrete id becomes a row categorized added/changed/unchanged/non-derivable; any
 * stored coefficient no longer in that set becomes a defensive `removed` row. Pure —
 * the draft is not touched until {@link applyContractedRefresh} runs on Confirm.
 */
export function deriveContractedRefresh(
  form: ContractedFormState,
  state: ScenarioUiState,
): RefreshPreview {
  const durationById = new Map<string, number | undefined>();
  for (const shift of state.shifts) {
    if (typeof shift.id === "string") durationById.set(shift.id, shift.durationMinutes);
  }

  const domain = buildContractedCoefficientDomain(state, form.countShiftTypes);
  const concreteIds = contractedCoefficientIds(domain);
  const concreteSet = new Set(concreteIds);

  const rows: RefreshRow[] = concreteIds.map((id) => {
    const current = coefficientValueFor(form.countShiftTypeCoefficients, id);
    const derived = deriveCoefficientValue(id, durationById);
    if (derived === null) return { id, category: "non-derivable", current, derived };
    const hasValue = current !== "";
    if (!hasValue) return { id, category: "added", current, derived };
    const isEqual = typeof current === "number" && current === derived;
    return { id, category: isEqual ? "unchanged" : "changed", current, derived };
  });

  // Defensive: a stored pair outside the concrete set (usually none, because the form
  // re-syncs coefficients on every selector change) is surfaced as `removed`.
  for (const [id, value] of form.countShiftTypeCoefficients) {
    if (!concreteSet.has(id)) rows.push({ id, category: "removed", current: value, derived: null });
  }

  // A selected STRING selector that does not resolve (a stale/deleted id) yields no
  // concrete leaf, so it never appears above. Surface it so the author can see and
  // fix the non-derivable selection — the recovery path the ticket requires.
  const unresolved: string[] = [];
  let map: ReturnType<typeof buildShiftTypeIndexMap> | null = null;
  try {
    map = buildShiftTypeIndexMap(state.shifts, state.shiftGroups);
  } catch (error) {
    if (!(error instanceof ShiftTypeMapError)) throw error;
    map = null; // A malformed scenario map is the commit gate's concern, not Refresh's.
  }
  if (map) {
    for (const selector of form.countShiftTypes) {
      if (typeof selector === "string" && expandShiftTypeSelector(selector, map) === null) {
        unresolved.push(selector);
      }
    }
  }

  return { rows, unresolved };
}

/**
 * Apply a confirmed Refresh preview to the OPEN DRAFT, returning the next
 * {@link ContractedFormState}. Added/changed ids take their derived value; unchanged
 * and non-derivable ids keep their existing manual value; removed ids are dropped.
 * The result's coefficient pairs are exactly the concrete id set (in preview order),
 * matching what a selector re-sync would hold. This is an in-draft edit only — it
 * does NOT commit a scenario mutation (the eventual card Save is the one mutation).
 *
 * A kept id's value is read LIVE from `form` (not the preview snapshot's `current`),
 * so a manual coefficient edited AFTER the preview was computed is preserved rather
 * than silently reverted to the snapshot. `derived` is only ever applied to
 * added/changed rows.
 */
export function applyContractedRefresh(
  form: ContractedFormState,
  preview: RefreshPreview,
): ContractedFormState {
  const countShiftTypeCoefficients: CoefficientPair[] = [];
  for (const row of preview.rows) {
    if (row.category === "removed") continue;
    const value =
      (row.category === "added" || row.category === "changed") && row.derived !== null
        ? row.derived
        : coefficientValueFor(form.countShiftTypeCoefficients, row.id);
    countShiftTypeCoefficients.push([row.id, value]);
  }
  return { ...form, countShiftTypeCoefficients };
}
