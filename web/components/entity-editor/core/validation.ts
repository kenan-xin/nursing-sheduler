// Id validation for the item/group editor (T09) — the verbatim parity messages
// (spec 03 Validation Rules V1–V6) plus the reserved-keyword + duplicate checks.
//
// Reserved keywords come from the descriptor (sourced from the shared
// `RESERVED_SHIFT_TYPE` constant, never hardcoded), matched case-insensitively —
// exactly as the producer schema + T07 collision authority compare. Duplicate
// detection uses EXACT identity (mirroring the producer/T07 duplicate rule), so
// the distinct ids `1` and `"1"` never falsely collide; the entity being edited
// is excluded so a no-op re-save is not flagged.
//
// Rename/inline-id changes are still ultimately guarded by T07's `renameEntity`
// (it throws `RenameCollisionError` before touching state); these checks produce
// the user-facing message up front and keep add-time (no rename) validated too.

import type { EditorGroup, EntityDescriptor, EntityId } from "./descriptor";

export type ValidationOk = { ok: true; id: string };
export type ValidationErr = { ok: false; message: string };
export type ValidationResult = ValidationOk | ValidationErr;

/** Whether `id` matches a reserved keyword for this domain (case-insensitive). */
export function isReservedKeyword(reserved: readonly string[], id: string): boolean {
  const upper = id.toUpperCase();
  return reserved.some((keyword) => keyword.toUpperCase() === upper);
}

/** All ids currently in use across items and groups (the shared id namespace). */
function usedIds(items: readonly { id: EntityId }[], groups: readonly EditorGroup[]): EntityId[] {
  return [...items.map((item) => item.id), ...groups.map((group) => group.id)];
}

/**
 * Whether `candidate` (an authored string id) collides with an existing item or
 * group id under exact identity, excluding the entity currently being edited.
 */
function isDuplicateId(
  items: readonly { id: EntityId }[],
  groups: readonly EditorGroup[],
  candidate: string,
  currentId?: EntityId,
): boolean {
  return usedIds(items, groups).some((id) => id !== currentId && id === candidate);
}

/**
 * Validate an id on the add/full-edit form (V1/V2/V3). Trims the input, then
 * checks empty → reserved → duplicate. On success returns the trimmed id.
 *
 * `isGroup` selects the empty-message label (Group vs the item label); the
 * duplicate message always reads "another {item} or group" per V3.
 */
export function validateFullEditId<TItem extends { id: EntityId }>(
  descriptor: EntityDescriptor<TItem>,
  items: readonly TItem[],
  groups: readonly EditorGroup[],
  rawId: string,
  isGroup = false,
  currentId?: EntityId,
): ValidationResult {
  const id = rawId.trim();
  const entityLabel = isGroup ? "Group" : descriptor.labels.item;
  if (id === "") {
    return { ok: false, message: `${entityLabel} ID cannot be empty` };
  }
  if (isReservedKeyword(descriptor.reservedKeywords, id) || descriptor.isReservedId?.(id)) {
    return { ok: false, message: `"${id}" is a reserved keyword and cannot be used as an ID` };
  }
  if (isDuplicateId(items, groups, id, currentId)) {
    return {
      ok: false,
      message: `This ID is already used by another ${descriptor.labels.itemLower} or group`,
    };
  }
  return { ok: true, id };
}

/**
 * Validate an id committed via inline edit (V4/V5/V6). Same empty → reserved →
 * duplicate order, but the duplicate message omits the trailing "or group": it
 * reads "another {person|shift type|group}" using the edited entity's own label.
 */
export function validateInlineId<TItem extends { id: EntityId }>(
  descriptor: EntityDescriptor<TItem>,
  items: readonly TItem[],
  groups: readonly EditorGroup[],
  rawId: string,
  isGroup = false,
  currentId?: EntityId,
): ValidationResult {
  const id = rawId.trim();
  const entityLabel = isGroup ? "Group" : descriptor.labels.item;
  if (id === "") {
    return { ok: false, message: `${entityLabel} ID cannot be empty` };
  }
  if (isReservedKeyword(descriptor.reservedKeywords, id) || descriptor.isReservedId?.(id)) {
    return { ok: false, message: `"${id}" is a reserved keyword and cannot be used as an ID` };
  }
  if (isDuplicateId(items, groups, id, currentId)) {
    const label = isGroup ? "group" : descriptor.labels.itemLower;
    return { ok: false, message: `This ID is already used by another ${label}` };
  }
  return { ok: true, id };
}
