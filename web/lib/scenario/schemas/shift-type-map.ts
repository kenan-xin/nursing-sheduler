// Ordered shift-type index map — a faithful TypeScript port of the vendored
// backend's `group_map.build_shift_type_index_map` (core/nurse_scheduling/
// group_map.py) and the reserved sentinels in `constants.py`.
//
// This is the semantic engine the producer validator uses to answer one C3-class
// question the T18 projection cannot: does a shift-request selector name a group
// whose expansion reaches the reserved OFF/LEAVE day-states? The backend expands
// such a selector *silently* (a request to a group `mixed:[D, LEAVE]` loads and
// solves — verified against the vendored Python: `build_shift_type_index_map`
// yields `mixed -> [-2, 0]` and `schedule()` returns OPTIMAL), so the producer
// layer is the only guard. Insertion/expansion order matches the backend exactly:
// items, then ALL/OFF/LEAVE, then groups in definition order resolving through the
// map built so far (so a forward reference / cycle / unknown id fails immediately).

import {
  RESERVED_SHIFT_TYPE,
  type CanonicalShiftType,
  type CanonicalShiftTypeGroup,
  type ShiftTypeGroupMember,
} from "../types";

/** Reserved shift-type index sentinels (core/nurse_scheduling/constants.py). */
export const OFF_SID = -1;
export const LEAVE_SID = -2;

/** A shift-type id key as stored in the map — kept as-is (number or string). */
export type ShiftTypeMapKey = number | string;

/** Result of a failed ordered-map construction (matches the backend message). */
export class ShiftTypeMapError extends Error {}

/**
 * Build the ordered shift-type `id -> [indices]` map, mirroring the backend's
 * `build_shift_type_index_map`. Worked shift types map to their index, `ALL`
 * expands to the worked shift types only (excluding OFF/LEAVE), `OFF`/`LEAVE`
 * map to their reserved sentinels, and each group resolves through the map built
 * so far. Throws `ShiftTypeMapError` on a forward reference, cycle, or unknown id.
 */
export function buildShiftTypeIndexMap(
  items: readonly Pick<CanonicalShiftType, "id">[],
  groups: readonly Pick<CanonicalShiftTypeGroup, "id" | "members">[] = [],
): Map<ShiftTypeMapKey, number[]> {
  const map = new Map<ShiftTypeMapKey, number[]>();
  const nShiftTypes = items.length;
  for (let s = 0; s < nShiftTypes; s++) {
    map.set(items[s].id, [s]);
  }
  // `ALL` intentionally expands to worked shift types only (no OFF/LEAVE).
  map.set(
    RESERVED_SHIFT_TYPE.all,
    Array.from({ length: nShiftTypes }, (_, i) => i),
  );
  map.set(RESERVED_SHIFT_TYPE.off, [OFF_SID]);
  map.set(RESERVED_SHIFT_TYPE.leave, [LEAVE_SID]);

  for (const group of groups) {
    const indices = new Set<number>();
    for (const member of group.members) {
      if (!map.has(member)) {
        throw new ShiftTypeMapError(
          `Shift type group ${quote(group.id)} references undefined shift type or group ID ` +
            `${quote(member)} (forward reference, cycle, or unknown id).`,
        );
      }
      for (const index of map.get(member)!) indices.add(index);
    }
    map.set(
      group.id,
      Array.from(indices).sort((a, b) => a - b),
    );
  }
  return map;
}

/**
 * Expand a single shift-type selector through the ordered map. Returns the sorted
 * unique index list, or `null` when the selector is not defined in the map (an
 * unknown id — the backend `parse_sids` raises "Unknown shift type ID" here).
 */
export function expandShiftTypeSelector(
  selector: ShiftTypeGroupMember,
  map: Map<ShiftTypeMapKey, number[]>,
): number[] | null {
  return map.has(selector) ? map.get(selector)! : null;
}

function quote(value: unknown): string {
  return typeof value === "string" ? `'${value}'` : String(value);
}
