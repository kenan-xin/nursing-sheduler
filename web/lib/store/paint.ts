// Quick-paint gesture protocol (T04, tech-plan §4). A paint drag stages
// per-coordinate intents in the HOT store (`beginPaint` + `stagePaintDayState` /
// `stagePaintRequestDelta` / `stagePaintErase`), so the drag itself never touches
// the durable store. On pointer-up the whole gesture commits as ONE atomic
// durable write — exactly one `setReqData` ⇒ one zundo entry ⇒ one persist
// revision — never one write per crossed cell.
//
// Reconciliation is a per-coordinate transaction (T11). A coordinate's staged
// `mode` decides how it folds into the existing `reqData` cells at that
// person×date:
//   • erase     → drop every cell at the coordinate.
//   • day-state → XOR replace with a single leave/off cell (drops requests),
//                 preserving an existing day-state cell's `uid` for F2 stability.
//   • requests  → additive per-selector deltas onto existing `request` cells
//                 (weight 0 removes that selector). PRECEDENCE: if the
//                 coordinate already holds a day-state, the request delta is
//                 SKIPPED — a bulk drag must not silently wipe a leave/off pin
//                 (mirrors the solver's LEAVE-hard-pin precedence). The user
//                 erases or uses the Normal-mode modal to convert it.
//
// Author-time XOR only: coexisting day-state + request cells that arrive from
// import are preserved until the user actively authors that coordinate.

import { paintCellKey } from "./types";
import type { HotStore } from "./hot-store";
import type { ScenarioStore } from "./scenario-store";
import type { PersonRef, DateRef, UiRequestCell } from "@/lib/scenario";

/** True for the day-state (`leave`/`off`) arm of a `UiRequestCell`. */
function isDayStateCell(cell: UiRequestCell): boolean {
  return cell.kind === "leave" || cell.kind === "off";
}

/**
 * Commit the staged paint gesture into the durable person×date matrix in a
 * single tracked write, then clear the staging buffer. No-op (and no durable
 * write) when nothing is staged.
 */
export function commitPaintGesture(scenario: ScenarioStore, hot: HotStore): void {
  const staged = hot.getState().paint;
  hot.getState().cancelPaint();
  if (!staged || staged.size === 0) return;

  // Group current cells by coordinate; untouched coordinates pass through verbatim.
  const byCoordinate = new Map<string, UiRequestCell[]>();
  for (const cell of scenario.getState().reqData) {
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
      // XOR: the coordinate becomes a single day-state cell, dropping requests.
      const priorDayState = existing.find(isDayStateCell);
      const { dayState } = intent;
      const cell: UiRequestCell =
        dayState.kind === "leave"
          ? { kind: "leave", person, date, uid: priorDayState?.uid }
          : { kind: "off", person, date, weight: dayState.weight, uid: priorDayState?.uid };
      byCoordinate.set(key, [cell]);
      continue;
    }

    // mode: "requests" — additive selector deltas onto existing request cells.
    // Precedence: an existing day-state at this coordinate wins; skip the delta
    // so a bulk drag cannot silently wipe a leave/off pin.
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
        uid: prev?.uid,
      });
    }
    byCoordinate.set(key, [...bySelector.values()]);
  }

  // One durable set → one zundo history entry → one persist write.
  scenario.getState().setReqData([...byCoordinate.values()].flat());
}
