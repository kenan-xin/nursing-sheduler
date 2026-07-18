// Quick-paint gesture reducer for the Shift Requests matrix (T11, FR-SR-27..33).
// Pure translation from a quick-paint preset + a crossed cell into store-staging
// descriptors, plus the brush-trail visited-once tracking and the deferred
// history clear-drag accumulator. No React, no store — `use-requests.ts` is the
// only consumer that touches `@/lib/store`.
//
// Parity source: `docs/design_prototype/ScreenRequests.dc.html` (`_computeCell`/
// `_paintCells` ~387-405) and the old app
// (`web-frontend/src/app/shift-requests/page.tsx` `handleDraggedCell`/
// `applyPreferenceCellEdit`/`applyHistoryCellEdit` ~1073-1242).

import { RESERVED_SHIFT_TYPE, type PersonId, type ShiftTypeRef, type Weight } from "@/lib/scenario";

// --- Preset → coordinate intent (FR-SR-27/30) --------------------------------

export type PaintCellIntent =
  | { mode: "erase" }
  | { mode: "day-state"; dayState: { kind: "leave" } | { kind: "off"; weight: Weight } }
  | { mode: "requests"; deltas: Map<ShiftTypeRef, Weight> };

/**
 * Translate a quick-paint preset (selected target ids + a parsed weight) into a
 * coordinate transaction (mirrors the prototype's `_computeCell`):
 *   - no targets selected → erase the coordinate.
 *   - `LEAVE` selected (alone or with anything else) → LEAVE wins, day-state leave.
 *   - selection is exactly `[OFF]` → day-state off at `weight`.
 *   - otherwise → additive request deltas for every selected id that is NOT
 *     OFF/LEAVE (OFF mixed with worked targets is dropped — only a *sole* OFF
 *     selection is a day-state, matching the old app's `_computeCell`).
 * Returns `null` when a weight is required (targets selected, no LEAVE) but
 * unparsed/invalid — the caller must stage nothing for this cell (mirrors
 * `_paintCells`'s early return when `parseW` yields `null`).
 */
export function computeQuickPaintCellIntent(
  selectedIds: readonly string[],
  weight: number | null,
): PaintCellIntent | null {
  if (selectedIds.length === 0) return { mode: "erase" };
  if (selectedIds.includes(RESERVED_SHIFT_TYPE.leave)) {
    return { mode: "day-state", dayState: { kind: "leave" } };
  }
  if (weight === null) return null;
  if (selectedIds.length === 1 && selectedIds[0] === RESERVED_SHIFT_TYPE.off) {
    return { mode: "day-state", dayState: { kind: "off", weight } };
  }
  const worked = selectedIds.filter(
    (id) => id !== RESERVED_SHIFT_TYPE.off && id !== RESERVED_SHIFT_TYPE.leave,
  );
  const deltas = new Map<ShiftTypeRef, Weight>(worked.map((id) => [id, weight]));
  return { mode: "requests", deltas };
}

// --- Brush-trail visited-once tracking (FR-SR-30) ----------------------------

export type PaintCellType = "preference" | "history";

/** The visited-cell key: `"{cellType}:{person}:{colRef|columnIndex}"`. */
export function visitedCellKey(
  cellType: PaintCellType,
  person: string | number,
  identifier: string | number,
): string {
  return `${cellType}:${String(person)}:${String(identifier)}`;
}

/**
 * Mark a cell visited for the current gesture; returns `true` the first time a
 * given (cellType, person, identifier) triple is seen during the drag, `false`
 * on every re-entry — the visited set is the drag's dedupe boundary (FR-SR-30),
 * so each crossed cell applies at most once.
 */
export function markCellVisited(
  visited: Set<string>,
  cellType: PaintCellType,
  person: string | number,
  identifier: string | number,
): boolean {
  const key = visitedCellKey(cellType, person, identifier);
  if (visited.has(key)) return false;
  visited.add(key);
  return true;
}

// --- History quick-paint (FR-SR-30/32/33) ------------------------------------

export type HistoryPaintSelection =
  | { kind: "clear" }
  | { kind: "set"; shiftType: string }
  | { kind: "skip" }
  | { kind: "error"; message: string };

/**
 * Resolve a quick-paint selection against the history-editing rule: no
 * selection clears; exactly one VALID history item sets that value — a worked
 * shift-type item or the reserved OFF/LEAVE (history may hold OFF/LEAVE,
 * matching the normal history editor and the old app's `shiftTypeData.items`,
 * which includes the AUTO_GENERATED_ITEMS OFF/LEAVE); an id outside
 * `validItemIds` (e.g. a shift-type group) is silently skipped (a history slot
 * cannot hold a group); more than one selection is a user error (verbatim
 * old-app message).
 */
export function resolveHistoryPaintSelection(
  selectedIds: readonly string[],
  validItemIds: ReadonlySet<string>,
): HistoryPaintSelection {
  if (selectedIds.length === 0) return { kind: "clear" };
  if (selectedIds.length > 1) {
    return { kind: "error", message: "Cannot set history to multiple shift types." };
  }
  const [id] = selectedIds;
  if (!validItemIds.has(id)) return { kind: "skip" };
  return { kind: "set", shiftType: id };
}

export type HistoryApplyPosition = { action: "append" } | { action: "update"; position: number };

/**
 * Where a rendered history `columnIndex` lands in the underlying `history`
 * array (FR-SR-07's right-alignment offset): a column left of the real entries
 * appends a new (newest) entry; a column over a real entry updates that
 * position in place.
 */
export function computeHistoryApplyPosition(
  columnIndex: number,
  historyLength: number,
  historyCount: number,
): HistoryApplyPosition {
  const offset = historyCount - historyLength;
  if (columnIndex < offset) return { action: "append" };
  return { action: "update", position: columnIndex - offset };
}

/**
 * The clear-mode target position for a rendered `columnIndex`, or `null` when
 * the column sits left of any real entry (nothing to clear there).
 */
export function computeHistoryClearPosition(
  columnIndex: number,
  historyLength: number,
  historyCount: number,
): number | null {
  const offset = historyCount - historyLength;
  if (columnIndex < offset) return null;
  return columnIndex - offset;
}

/**
 * Deferred history-clear accumulator (FR-SR-33): record the DEEPEST cleared
 * position per person during a drag (`Math.max`), flushed as one truncation per
 * person on pointer-up — clearing a later position also removes every entry
 * newer than it, so only the deepest target per person need be kept.
 */
export function accumulateDeepestClear(
  pending: Map<PersonId, number>,
  personId: PersonId,
  position: number,
): void {
  const existing = pending.get(personId);
  pending.set(personId, existing === undefined ? position : Math.max(existing, position));
}

/**
 * Truncate a person's history "through" `position` (old app's
 * `updatePersonHistory(person, position, undefined)`): drop entry `position`
 * and everything newer than it (indices `0..position`, since `history[0]` is
 * the newest entry), keeping only the older tail.
 */
export function truncateHistoryThroughPosition(
  history: readonly string[],
  position: number,
): string[] {
  return history.slice(position + 1);
}

/** Prepend a new (newest) entry to a person's history (old app's `addPersonHistory`). */
export function prependHistoryEntry(history: readonly string[], shiftType: string): string[] {
  return [shiftType, ...history];
}

/** Update a person's history at an existing position, leaving the rest intact. */
export function updateHistoryAtPosition(
  history: readonly string[],
  position: number,
  shiftType: string,
): string[] {
  const next = [...history];
  next[position] = shiftType;
  return next;
}
