// The quick-paint reconciliation, pure (extracted from `paint.ts`).
//
// ONE FOLD, TWO CALLERS: the Requests page's paint gesture (`commitPaintGesture`)
// and the assistant's leave/request arms (`lib/proposal/operations.ts`). It has no
// store, no React and no clock. The only non-determinism the page needs -- a fresh
// `uid` for a brand-new cell -- is injected, so the assistant can mint the SAME ids
// when it prepares a Preview and when Apply re-derives it.
//
// A coordinate's staged `mode` decides how it folds into the cells at that
// person×date:
//   • erase     → drop every cell at the coordinate.
//   • day-state → XOR replace with a single leave/off cell (drops requests),
//                 preserving an existing day-state cell's `uid` for F2 stability.
//   • requests  → additive per-selector deltas onto existing `request` cells
//                 (weight 0 removes that selector). PRECEDENCE: if the
//                 coordinate already holds a day-state, the delta is SKIPPED -- a
//                 bulk drag must not silently wipe a leave/off pin.
//
// Author-time XOR only: coexisting day-state + request cells that arrive from
// import are preserved until the user actively authors that coordinate.

import type { DateRef, PersonRef, UiRequestCell } from "@/lib/scenario";
import { paintCellKey, type StagedCoordinate } from "./types";

/** Mint a durable `uid` for a brand-new cell. `selector` is `leave`, `off` or `request:<shift>`. */
export type MintCellUid = (person: PersonRef, date: DateRef, selector: string) => string;

/** True for the day-state (`leave`/`off`) arm of a `UiRequestCell`. */
function isDayStateCell(cell: UiRequestCell): boolean {
  return cell.kind === "leave" || cell.kind === "off";
}

/** Reconcile staged per-coordinate intents against a matrix. Untouched coordinates pass through verbatim. */
export function foldPaintIntents(
  reqData: readonly UiRequestCell[],
  staged: ReadonlyMap<string, StagedCoordinate>,
  mintUid: MintCellUid,
): UiRequestCell[] {
  const byCoordinate = new Map<string, UiRequestCell[]>();
  for (const cell of reqData) {
    const key = paintCellKey(cell.person, cell.date);
    const cells = byCoordinate.get(key);
    if (cells) cells.push(cell);
    else byCoordinate.set(key, [cell]);
  }

  for (const [key, intent] of staged) {
    const [person, date] = JSON.parse(key) as [PersonRef, DateRef];
    const existing = byCoordinate.get(key) ?? [];

    if (intent.mode === "erase") {
      byCoordinate.set(key, []);
      continue;
    }

    if (intent.mode === "day-state") {
      const priorDayState = existing.find(isDayStateCell);
      const { dayState } = intent;
      const uid = priorDayState?.uid ?? mintUid(person, date, dayState.kind);
      const cell: UiRequestCell =
        dayState.kind === "leave"
          ? { kind: "leave", person, date, uid }
          : { kind: "off", person, date, weight: dayState.weight, uid };
      byCoordinate.set(key, [cell]);
      continue;
    }

    if (existing.some(isDayStateCell)) continue;

    const bySelector = new Map<string, UiRequestCell>();
    for (const cell of existing) {
      if (cell.kind === "request") bySelector.set(cell.shiftType, cell);
    }
    for (const [selector, weight] of intent.deltas) {
      if (weight === 0) {
        bySelector.delete(selector);
        continue;
      }
      const prev = bySelector.get(selector);
      bySelector.set(selector, {
        kind: "request",
        person,
        date,
        shiftType: selector,
        weight,
        uid: prev?.uid ?? mintUid(person, date, `request:${selector}`),
      });
    }
    byCoordinate.set(key, [...bySelector.values()]);
  }

  return [...byCoordinate.values()].flat();
}
