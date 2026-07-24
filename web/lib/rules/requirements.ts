// Requirement → shift-type reverse index — pure, React-free (DR-H).
//
// "Which requirements cover this shift type?" — group-EXPANDING (reusing the same
// `expandShiftTypeRefs` the coverage banner uses), so a requirement that reaches
// the shift only through a (possibly nested) group is found too. Each hit is
// classified so a consumer can render an honest, non-confusing state:
//
//   • DIRECT-SIMPLE — the card targets exactly this one shift item, by id.
//   • GROUP-DERIVED — the card resolves to this single shift, but via a group
//     (or a non-literal ref), not a direct `[id]`.
//   • MULTI-TARGET  — the card covers more than one shift type (this id + others).
//
// A `disabled` card is excluded entirely: the canonical projection drops it, so
// it cannot count as coverage.

import { type RequirementCard, type ScenarioUiState, type ShiftTypeId } from "@/lib/scenario";
import { expandShiftTypeRefs, flattenShiftTypeRefs } from "./expansion";

/** How a requirement card reaches the queried shift type. */
export type RequirementMatchKind = "DIRECT-SIMPLE" | "GROUP-DERIVED" | "MULTI-TARGET";

/** One requirement that covers the queried shift type, with its classification. */
export interface RequirementMatch {
  /** The matching requirement card. */
  card: RequirementCard;
  /** Its 0-based position in `state.cardsByKind.requirements`. */
  index: number;
  /** How the card reaches the queried shift type. */
  kind: RequirementMatchKind;
  /** Every concrete shift-type item id the card expands to (sorted). */
  coveredShiftTypes: string[];
}

/**
 * The ACTIVE (non-disabled) requirements that cover `id`, each classified. Group
 * membership is expanded (nested groups included), so a requirement targeting a
 * group that contains the shift is reported as `GROUP-DERIVED`; one targeting
 * several shift types (including this one) is `MULTI-TARGET`; one targeting only
 * this shift item by its literal id is `DIRECT-SIMPLE`. Returns `[]` when nothing
 * covers the shift. Pure — reads state, never mutates it.
 */
export function requirementsForShiftType(
  state: ScenarioUiState,
  id: ShiftTypeId,
): RequirementMatch[] {
  const target = String(id);
  const isShiftItem = state.shifts.some((s) => String(s.id) === target);
  const matches: RequirementMatch[] = [];

  state.cardsByKind.requirements.forEach((card, index) => {
    if (card.disabled) return;
    const directRefs = flattenShiftTypeRefs(card.shiftType);
    const expanded = expandShiftTypeRefs(directRefs, state);
    if (!expanded.has(target)) return;

    let kind: RequirementMatchKind;
    if (expanded.size > 1) {
      kind = "MULTI-TARGET";
    } else if (directRefs.length === 1 && String(directRefs[0]) === target && isShiftItem) {
      kind = "DIRECT-SIMPLE";
    } else {
      kind = "GROUP-DERIVED";
    }

    matches.push({
      card,
      index,
      kind,
      coveredShiftTypes: [...expanded].sort(),
    });
  });

  return matches;
}
