// Requirement selector expansion — pure, React-free helpers (DR-H).
//
// These were previously private to `components/requirements/requirements-model.ts`
// (they powered `computeCoverageWarnings`). They are relocated here VERBATIM so
// the SHARED FOUNDATION consumed by both the domain-UI Shift Types card (DR-4)
// and the Tier-1 conflict detector imports one copy — never a re-paste. Nothing
// here touches React, the store, or any AI surface; every function is a pure
// map over serializable scenario state.
//
// The only change from the originals is a widened parameter type: each helper
// takes the narrow `Pick<ScenarioUiState, …>` slice it actually reads, so a
// caller can pass either a full `ScenarioUiState` (unchanged behaviour — the
// requirements coverage banner) or a minimal context object (the new
// `isAllDates` predicate). Behaviour for a full-state caller is identical.

import {
  RESERVED_SHIFT_TYPE,
  type DateRef,
  type NestedShiftTypeRefList,
  type ScenarioUiState,
  type ShiftTypeRef,
  type UiDateGroup,
} from "@/lib/scenario";

/** A derived/authored date group reduced to the fields expansion needs. */
export interface DerivedGroupLike {
  id: string;
  members: readonly string[];
}

/**
 * Flatten a (possibly nested, possibly scalar) shift-type ref tree to a flat
 * list — defensive for imported data. The Requirements UI only ever WRITES a
 * flat `[id]`, but a loaded/imported card may carry a `NestedShiftTypeRefList`.
 */
export function flattenShiftTypeRefs(tree: ShiftTypeRef | NestedShiftTypeRefList): ShiftTypeRef[] {
  if (Array.isArray(tree)) return tree.flatMap((node) => flattenShiftTypeRefs(node));
  return [tree];
}

/**
 * Expand date refs (keywords, derived groups, authored groups, or concrete date
 * ids) into the concrete set of date ids they cover. `ALL` (case-insensitive)
 * covers every generated date; a derived group id (WEEKDAY/WEEKEND/…) or an
 * authored `state.dateGroups` id expands to its members; anything else is treated
 * as a concrete date id and added verbatim.
 */
export function expandDateRefs(
  refs: readonly DateRef[],
  state: { dateGroups: readonly UiDateGroup[] },
  allDateIds: readonly string[],
  derivedGroups: readonly DerivedGroupLike[],
): Set<string> {
  const set = new Set<string>();
  const derivedByUpper = new Map(derivedGroups.map((g) => [g.id.toUpperCase(), g.members]));
  const authoredById = new Map(state.dateGroups.map((g) => [String(g.id), g.members.map(String)]));
  for (const ref of refs) {
    const key = String(ref);
    if (key.toUpperCase() === RESERVED_SHIFT_TYPE.all) {
      allDateIds.forEach((d) => set.add(d));
      continue;
    }
    const derived = derivedByUpper.get(key.toUpperCase());
    if (derived) {
      derived.forEach((d) => set.add(d));
      continue;
    }
    const authored = authoredById.get(key);
    if (authored) {
      authored.forEach((d) => set.add(d));
      continue;
    }
    set.add(key);
  }
  return set;
}

/**
 * Expand shift-type refs (item ids and/or group ids) into the concrete set of
 * shift-type item ids they cover. A group id recurses into its members (nested
 * groups included) with a cycle guard; an item id is added directly; an unknown
 * ref contributes nothing.
 */
export function expandShiftTypeRefs(
  refs: readonly ShiftTypeRef[],
  state: Pick<ScenarioUiState, "shifts" | "shiftGroups">,
  seen: ReadonlySet<string> = new Set(),
): Set<string> {
  const set = new Set<string>();
  const itemIds = new Set(state.shifts.map((s) => String(s.id)));
  for (const ref of refs) {
    const key = String(ref);
    if (itemIds.has(key)) {
      set.add(key);
      continue;
    }
    if (seen.has(key)) continue;
    const group = state.shiftGroups.find((g) => String(g.id) === key);
    if (group) {
      const nextSeen = new Set(seen).add(key);
      expandShiftTypeRefs(group.members.map(String), state, nextSeen).forEach((id) => set.add(id));
    }
  }
  return set;
}
