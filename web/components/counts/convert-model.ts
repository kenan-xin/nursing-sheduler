// Convert ↔ generic pure model (T12 M2a-4, spec DL09 D9 / FR-CH-25c / AC-CH-23).
// The two side-effect-free transforms behind the Convert action, kept out of the
// React shells so they are provable in the `node` vitest env:
//
//   • contracted → generic: strip ONLY the marker (`tag`/`policy`/`unit`),
//     preserving every raw field and the UI markers (`uid`/`disabled`/`applied`).
//     An Exact contract's raw fields are scalar, so the result is an editable
//     `OrdinaryCountCard`; a Range contract's raw fields are arrays, so the result
//     is (automatically, via `isAdvancedCountCard`) an unmarked advanced/list card
//     — no special-casing here beyond dropping the marker.
//
//   • generic → contracted: seed a guided `ContractedFormState` from a scalar
//     generic card — carry description/person/countDates/countShiftTypes and the
//     existing coefficients (re-synced to the CONCRETE contracted domain, preserved
//     as manual overrides), default policy "exact", and leave the target BLANK (the
//     generic `target` is a shift COUNT, not hours, so the author must re-enter the
//     contracted hours). Building the marked card and replacing in place is the
//     editor's job (through the guided form's coverage gate) — this only seeds.

import type {
  ContractedHoursCountCard,
  CountCard,
  OrdinaryCountCard,
  ScenarioUiState,
  ShiftTypeRef,
} from "@/lib/scenario";
import {
  syncCoefficientPairs,
  type CoefficientPair,
} from "@/components/card-editor/coefficient-fields";
import {
  buildContractedCoefficientDomain,
  contractedCoefficientIds,
  type ContractedFormState,
} from "./contracted-model";

/**
 * Strip the contracted-hours marker from a card, keeping everything else. Removes
 * `tag`/`policy`/`unit` and preserves the raw preference fields plus the UI markers
 * (`uid`/`disabled`/`applied`). The result's editability falls out of its raw
 * shape: a scalar (Exact) contract becomes an editable `OrdinaryCountCard`; an
 * array (Range) contract becomes an unmarked advanced/list card recognized by
 * `isAdvancedCountCard`. Pure — the editor commits it via `replaceCard`.
 */
export function convertContractedToGeneric(card: ContractedHoursCountCard): CountCard {
  const rest: Record<string, unknown> = { ...card };
  delete rest.tag;
  delete rest.policy;
  delete rest.unit;
  return rest as unknown as CountCard;
}

/**
 * Seed a guided contracted-hours draft from a scalar generic count. Carries the
 * description/person/countDates/countShiftTypes and re-syncs the existing
 * coefficients against the CONCRETE contracted domain (a stale id from a
 * since-changed group is dropped; a newly-eligible id gets a blank slot) so the
 * author's manual overrides survive. Policy defaults to "exact" and the target is
 * left BLANK — the generic `target` was a shift COUNT, not contracted hours, so it
 * must be (re-)authored in the guided form. Callers guard with
 * `isEditableCountCard` first; a non-scalar card is not a valid input here.
 */
export function seedContractedFormFromGeneric(
  card: OrdinaryCountCard,
  state: ScenarioUiState,
): ContractedFormState {
  const countShiftTypes = Array.isArray(card.countShiftTypes)
    ? [...card.countShiftTypes]
    : [card.countShiftTypes];
  const domain = buildContractedCoefficientDomain(state, countShiftTypes);
  return {
    description: card.description ?? "",
    person: Array.isArray(card.person) ? [...card.person] : [card.person],
    countDates: Array.isArray(card.countDates) ? [...card.countDates] : [card.countDates],
    countShiftTypes: countShiftTypes as ShiftTypeRef[],
    countShiftTypeCoefficients: syncCoefficientPairs(
      contractedCoefficientIds(domain),
      (card.countShiftTypeCoefficients ?? []) as CoefficientPair[],
      domain,
    ),
    policy: "exact",
    targetExact: "",
    targetRangeMin: "",
    targetRangeMax: "",
  };
}
