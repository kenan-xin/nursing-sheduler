"use client";

// Read-only feasibility options (plan 2026-09-24 guided setup and repair).
//
// Runs the static staffing check and the playbook ranking over the live committed
// scenario. It writes nothing: an option becomes a change only through
// prepare_scenario_change or test_feasibility_candidates, and only the user applies it.

import { z } from "zod";
import { useModelVisibleTool } from "./register-model-visible-tool";
import { pickScenario, useScenarioStore } from "@/lib/store";
import { buildFeasibilityReport } from "@/lib/ai/assistant/repair-options";

export const feasibilityParameters = z.object({
  afterInfeasibleRun: z
    .boolean()
    .describe(
      "True only when an Optimize run of the schedule as it stands now came back infeasible. " +
        "Then options are offered even when no certain cause is found, labelled as guesses.",
    ),
});

export function useFeasibilityTools(agentId: string, turnEpoch: number): void {
  useModelVisibleTool(
    {
      name: "suggest_feasibility_options",
      agentId,
      description:
        "Find where the schedule is short-staffed and get up to three realistic, safe ways to fix " +
        "it, best first: for example borrowing a nurse from another ward, asking a named nurse on " +
        "leave, or allowing one more night this period. Each option lists its exact operations and " +
        "who must agree. Use it before running Optimize when set-up progress reports known gaps, " +
        "and whenever a run is infeasible. It changes nothing.",
      parameters: feasibilityParameters,
      handler: async (args) =>
        buildFeasibilityReport(pickScenario(useScenarioStore.getState()), args.afterInfeasibleRun),
    },
    [agentId, turnEpoch],
  );
}
