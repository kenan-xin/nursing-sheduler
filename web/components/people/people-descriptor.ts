// People descriptor (T09) — the thin wrapper that adapts the People domain to the
// generic item/group editor. It names the cascade namespace, the reserved keyword
// (only `ALL` for people), reads/writes the `staff` + `staffGroups` slices, and
// stamps a fresh `history: []` on every new person. People carry no working time,
// and per DL10 no role/seniority field is authored here (seniority lives in groups
// + coverings). The synthetic read-only row is the `ALL` group.

import {
  RESERVED_SHIFT_TYPE,
  type PersonId,
  type ScenarioUiState,
  type UiPerson,
} from "@/lib/scenario";
import type { EntityDescriptor } from "@/components/entity-editor/core";

export const peopleDescriptor: EntityDescriptor<UiPerson> = {
  domain: "person",
  labels: {
    item: "Person",
    itemPlural: "People",
    itemLower: "person",
    itemPluralLower: "people",
  },
  reservedKeywords: [RESERVED_SHIFT_TYPE.all],
  supportsWorkingTime: false,
  readItems: (state: ScenarioUiState) => state.staff,
  readGroups: (state: ScenarioUiState) => state.staffGroups,
  writeState: (state, patch) => ({
    ...state,
    staff: patch.items ?? state.staff,
    staffGroups: patch.groups ?? state.staffGroups,
  }),
  createItem: ({ id, description }) => ({ id, description, history: [] }),
  syntheticItems: [],
  syntheticGroups: [{ id: RESERVED_SHIFT_TYPE.all, description: "Everyone" }],
};

/**
 * Mark one person temporary (borrowed from another ward, float pool or agency) or
 * not. The Staff row's Save and the assistant's `add_person` / `edit_person` both
 * write the flag through here. Only `true` is stored; the same state comes back when
 * nothing changes, so an unchanged Save makes no undo entry.
 */
export function writeTemporary(
  state: ScenarioUiState,
  id: PersonId,
  temporary: boolean,
): ScenarioUiState {
  const index = state.staff.findIndex((person) => Object.is(person.id, id));
  if (index === -1 || (state.staff[index].temporary === true) === temporary) return state;
  const next = { ...state.staff[index] };
  delete next.temporary;
  const staff = state.staff.slice();
  staff[index] = temporary ? { ...next, temporary: true } : next;
  return peopleDescriptor.writeState(state, { items: staff });
}
