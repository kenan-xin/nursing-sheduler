// Shift-types descriptor (T09) — the thin wrapper adapting the Shift Types domain
// to the generic item/group editor. The cascade namespace is "shift"; reserved
// keywords are `ALL`/`OFF`/`LEAVE` (sourced from the shared constant, never
// hardcoded). It reads/writes the `shifts` + `shiftGroups` slices and enables the
// working-time sub-form. The synthetic read-only rows are the `OFF`/`LEAVE` shift
// types and the `ALL` group — all generated, never stored.

import { RESERVED_SHIFT_TYPE, type ScenarioUiState, type UiShiftType } from "@/lib/scenario";
import type { EntityDescriptor } from "@/components/entity-editor/core";

export const shiftTypesDescriptor: EntityDescriptor<UiShiftType> = {
  domain: "shift",
  labels: {
    item: "Shift Type",
    itemPlural: "Shift Types",
    itemLower: "shift type",
    itemPluralLower: "shift types",
  },
  reservedKeywords: [RESERVED_SHIFT_TYPE.all, RESERVED_SHIFT_TYPE.off, RESERVED_SHIFT_TYPE.leave],
  supportsWorkingTime: true,
  readItems: (state: ScenarioUiState) => state.shifts,
  readGroups: (state: ScenarioUiState) => state.shiftGroups,
  writeState: (state, patch) => ({
    ...state,
    shifts: patch.items ?? state.shifts,
    shiftGroups: patch.groups ?? state.shiftGroups,
  }),
  createItem: ({ id, description }) => ({ id, description }),
  syntheticItems: [
    { id: RESERVED_SHIFT_TYPE.off, description: "Day off (reserved)" },
    { id: RESERVED_SHIFT_TYPE.leave, description: "Leave (reserved)" },
  ],
  syntheticGroups: [{ id: RESERVED_SHIFT_TYPE.all, description: "Every shift type" }],
};
