// People descriptor (T09) — the thin wrapper that adapts the People domain to the
// generic item/group editor. It names the cascade namespace, the reserved keyword
// (only `ALL` for people), reads/writes the `staff` + `staffGroups` slices, and
// stamps a fresh `history: []` on every new person. People carry no working time,
// and per DL10 no role/seniority field is authored here (seniority lives in groups
// + coverings). The synthetic read-only row is the `ALL` group.

import { RESERVED_SHIFT_TYPE, type ScenarioUiState, type UiPerson } from "@/lib/scenario";
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
