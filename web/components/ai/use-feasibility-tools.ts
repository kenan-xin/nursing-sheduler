"use client";

// Read-only feasibility options (plan 2026-09-24 guided setup and repair).
//
// Runs the static staffing check and the playbook ranking over the live committed
// scenario. It writes nothing: an option becomes a change only through
// prepare_scenario_change or test_feasibility_candidates, and only the user applies it.

import { z } from "zod";
import { useModelVisibleTool } from "./register-model-visible-tool";
import { pickScenario, useHotStore, useScenarioStore } from "@/lib/store";
import { buildFeasibilityReport } from "@/lib/ai/assistant/repair-options";
import { resolveCore } from "@/lib/optimize/explanation";
import type { OptimizeRunView } from "@/lib/optimize/run-view";

export const feasibilityParameters = z.object({
  afterInfeasibleRun: z
    .boolean()
    .describe(
      "True only when an Optimize run of the schedule as it stands now came back infeasible. " +
        "Then options are offered even when no certain cause is found, labelled as guesses. " +
        "The app checks this against the run the Optimise screen shows.",
    ),
});

/** The failed run's proven core, named by rule id and real person, or null (msnp). */
export function provenCoreOf(view: OptimizeRunView) {
  const explanation = view.result?.explanation;
  if (explanation?.kind !== "infeasible" || !explanation.core || !view.explainContext) return null;
  return resolveCore(explanation.core, view.explainContext);
}

export function useFeasibilityTools(agentId: string, turnEpoch: number): void {
  useModelVisibleTool(
    {
      name: "suggest_feasibility_options",
      agentId,
      description:
        "Find where the schedule is short-staffed and get up to three realistic, safe ways to fix " +
        "it, best first: for example borrowing a nurse from another ward, adding a nurse to the " +
        "staff list, moving or giving up a named nurse's leave day with her agreement, or allowing one more night this period. Each option lists its exact operations and " +
        "who must agree. Use it before running Optimize when set-up progress reports known gaps, " +
        "and whenever a run is infeasible. It changes nothing.",
      parameters: feasibilityParameters,
      // The host's own run view decides; the model's flag is kept for the schema only.
      handler: async () => {
        const view = useHotStore.getState().runView;
        const infeasible = view.lifecycle === "completed" && view.outcome === "infeasible";
        return buildFeasibilityReport(
          pickScenario(useScenarioStore.getState()),
          infeasible,
          infeasible ? provenCoreOf(view) : null,
        );
      },
    },
    [agentId, turnEpoch],
  );
}
