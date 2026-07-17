// Dates domain descriptor for the shared entity-editor core (T10 + fs7).
//
// Spec 03 mandates one shared group-editing core across People / Shift Types /
// Dates. People + Shift Types drive the full generic `EntityEditor` (item table +
// transfer-list membership); Dates has no item table and its membership is a
// calendar day-scope, so it reuses ONLY the pure group CRUD/validation core
// (`addGroup` / `renameGroup` / `deleteGroup` / `setGroupMembers` /
// `validate*Id`, all in `entity-editor/core`) behind a descriptor, instead of the
// bespoke membership-only editor T10 shipped in Wave A.
//
// The descriptor's "items" are the DERIVED per-day date items of the committed
// range (never stored, never created by the editor): they give the core the id
// namespace for duplicate-name validation (a group named `15` collides with the
// date id `15`, matching T07's `renameEntity(state,"date",…)` authority) and the
// canonical member order for `setGroupMembers`. The group slice is `dateGroups`.
// Reserved keywords are the read-only auto-derived ids (ALL / WEEKDAY / WEEKEND /
// weekday names), so the core rejects them as custom-group names up front, the
// same set the producer schema + T07 reject case-insensitively.

import type { EditorGroup, EntityDescriptor } from "@/components/entity-editor/core";
import type { ScenarioUiState, UiDateGroup } from "@/lib/scenario";
import { DERIVED_DATE_GROUP_IDS, generateDateItems, isDateLiteralGroupId } from "@/lib/dates";

/** A derived date item as the core sees it (id + human label). */
export interface DateEditorItem {
  id: string;
  description: string;
}

const RESERVED_DATE_GROUP_IDS: readonly string[] = [...DERIVED_DATE_GROUP_IDS];

/** The Dates descriptor: group CRUD over `dateGroups`, items derived from range. */
export const datesDescriptor: EntityDescriptor<DateEditorItem> = {
  domain: "date",
  labels: {
    item: "Date",
    itemPlural: "Dates",
    itemLower: "date",
    itemPluralLower: "dates",
  },
  reservedKeywords: RESERVED_DATE_GROUP_IDS,
  supportsWorkingTime: false,
  // Reject concrete date-literal shapes (`D` / `MM-DD` / `YYYY-MM-DD`) at
  // create/rename — the derived keywords above are handled by `reservedKeywords`;
  // this covers the off-grid literals the producer + T07 also reject.
  isReservedId: isDateLiteralGroupId,

  readItems(state: ScenarioUiState): DateEditorItem[] {
    return generateDateItems({ start: state.rangeStart, end: state.rangeEnd }).map((item) => ({
      id: item.id,
      description: item.description,
    }));
  },
  readGroups(state: ScenarioUiState): EditorGroup[] {
    return state.dateGroups as unknown as EditorGroup[];
  },
  writeState(state: ScenarioUiState, patch: { groups?: EditorGroup[] }): ScenarioUiState {
    if (patch.groups === undefined) return state;
    return { ...state, dateGroups: patch.groups as unknown as UiDateGroup[] };
  },
  // Date items are generated from the range, never authored — the editor never
  // calls `addItem`/`duplicateItem`/`reorderByUpload`, so `createItem` is a
  // defensive stub kept off the group-editing paths this descriptor exercises.
  createItem(fields: { id: string; description?: string }): DateEditorItem {
    return { id: fields.id, description: fields.description ?? "" };
  },

  syntheticItems: [],
  syntheticGroups: [],
};
