// Group-membership ordering (T09). The prototype keeps every group's members in
// item order and re-sorts on add / full-edit / item-reorder (spec 03 FR-ED-08,
// FR-ED-10, FR-ED-21) — the order members were selected in is never preserved.
//
// Members authored through the editor's transfer list are always item ids, so
// they sort by their index in the item list. Any member NOT in the item list
// (e.g. a nested group id carried in from an import) has no item position; those
// are kept, in their original relative order, appended after the sorted items so
// the membership SET is preserved even though the editor never authors them.

import { sameEntityId, type EntityId } from "./descriptor";

/**
 * Re-sort `members` to match `itemOrder`, preserving MULTIPLICITY. Every exact
 * occurrence of an item id is emitted, grouped in item order (so `[1, 1, "1", "B"]`
 * with order `["B", 1]` → `["B", 1, 1]` then the unknown/nested tail). Members that
 * are not in `itemOrder` (nested group ids carried in from an import) keep their
 * original relative order, appended after the ordered items. The backend member
 * arrays are `list[int | str]` with NO uniqueness refinement
 * (`core/nurse_scheduling/models.py`), so collapsing duplicates via `new Set` would
 * silently drop valid data — matching is EXACT typed identity (`Object.is`).
 */
export function sortMembersByItemOrder(
  members: readonly EntityId[],
  itemOrder: readonly EntityId[],
): EntityId[] {
  const remaining = members.slice();
  const ordered: EntityId[] = [];
  for (const id of itemOrder) {
    for (let i = 0; i < remaining.length;) {
      if (sameEntityId(remaining[i], id)) {
        ordered.push(remaining[i]);
        remaining.splice(i, 1);
      } else {
        i += 1;
      }
    }
  }
  // `remaining` now holds only members not matched by any item id, original order.
  return [...ordered, ...remaining];
}
