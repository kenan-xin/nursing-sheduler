// Quick-paint gesture protocol (T04, tech-plan §4). A paint drag stages cell
// changes in the HOT store (`beginPaint` / `stagePaintCell`), so the drag itself
// never touches the durable store. On pointer-up the whole gesture commits as
// ONE atomic durable write — exactly one `setReqData` ⇒ one zundo entry ⇒ one
// persist revision — never one write per crossed cell.

import { paintCellKey } from "./types";
import type { HotStore } from "./hot-store";
import type { ScenarioStore } from "./scenario-store";

/**
 * Commit the staged paint gesture into the durable person×date matrix in a
 * single tracked write, then clear the staging buffer. A staged `null` erases the
 * cell at that coordinate; a staged cell upserts it. No-op (and no durable write)
 * when nothing is staged.
 */
export function commitPaintGesture(scenario: ScenarioStore, hot: HotStore): void {
  const staged = hot.getState().paint;
  hot.getState().cancelPaint();
  if (!staged || staged.size === 0) return;

  const byCoordinate = new Map(
    scenario.getState().reqData.map((cell) => [paintCellKey(cell.person, cell.date), cell]),
  );

  for (const [key, cell] of staged) {
    if (cell === null) byCoordinate.delete(key);
    else byCoordinate.set(key, cell);
  }

  // One durable set → one zundo history entry → one persist write.
  scenario.getState().setReqData([...byCoordinate.values()]);
}
