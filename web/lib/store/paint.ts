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
//
// T03: the commit target is now a repository command, so one drag is one durable
// commit and one Undo entry — and a drag that fails ownership leaves the matrix
// exactly as it was rather than showing a paint the store never saved.
//
// The fold itself is `foldPaintIntents` in `paint-fold.ts`.

import { scenarioCommands } from "./commands";
import { foldPaintIntents } from "./paint-fold";
import type { HotStore } from "./hot-store";
import type { CommandOutcome } from "./authority";

/**
 * Commit the staged paint gesture into the person×date matrix as ONE repository
 * command, then clear the staging buffer. No-op (and no durable commit) when
 * nothing is staged.
 *
 * The fold runs inside the command's updater, which the bus resolves when the
 * command reaches the head of the queue. That matters: a drag that ends while an
 * earlier edit is still committing must reconcile against the state that edit
 * produced, not against the matrix the drag started on.
 */
export function commitPaintGesture(hot: HotStore): Promise<CommandOutcome> {
  const staged = hot.getState().paint;
  hot.getState().cancelPaint();
  if (!staged || staged.size === 0) {
    return Promise.resolve({
      ok: true,
      committed: false,
      documentRevision: -1,
      commitId: null,
    });
  }
  // A brand-new cell gets a durable uid at creation so its Workspace identity never
  // depends on array position (T17r review P1). The fold itself lives in
  // `paint-fold.ts`, shared with the assistant's leave/request arms.
  return scenarioCommands.setReqData((current) =>
    foldPaintIntents(current.reqData, staged, () => crypto.randomUUID()),
  );
}
