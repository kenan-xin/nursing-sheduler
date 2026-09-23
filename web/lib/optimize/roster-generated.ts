// Whether the run the Optimise screen shows produced a roster the app kept. One rule
// for get_optimize_result, get_setup_progress and Home's Generate card.

import { getRosterCaptureGate } from "./roster-capture-app";
import type { OptimizeRunView } from "./run-view";

/** The capture gate committed this run's roster to the app. */
export const isRosterSaved = (view: OptimizeRunView): boolean =>
  view.jobId !== null && getRosterCaptureGate().getState(view.jobId).status === "committed";

/** The run found a roster (optimal or feasible) and the app saved it. */
export const isRosterGenerated = (view: OptimizeRunView): boolean =>
  view.lifecycle === "completed" &&
  (view.outcome === "optimal" || view.outcome === "feasible") &&
  isRosterSaved(view);
