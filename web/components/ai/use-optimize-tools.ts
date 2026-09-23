"use client";

// The assistant's optimiser tools (plan 2026-09-24-assistant-optimize-run).
//
// THE MODEL ASKS; THE USER STARTS. `request_optimize_run` only shows a host card.
// The run begins when the user presses Run on it, and then through the Optimize
// screen's own `onSubmit` -- the exact path the Optimize button takes (see
// `lib/optimize/run-request.ts`). `get_optimize_result` reads the run view that
// screen renders. Neither tool starts, stops or alters a run, and neither takes an
// argument, so there is no payload for the model to shape.

import { useParameterlessModelVisibleTool } from "./register-model-visible-tool";
import {
  pickScenario,
  readAuthoritativeScenarioOwnership,
  useHotStore,
  useScenarioStore,
} from "@/lib/store";
import { deriveOptimizeReadiness } from "@/lib/optimize/optimize-readiness";
import { terminalHeading } from "@/lib/optimize/run-display";
import type { OptimizeRunView } from "@/lib/optimize/run-view";
import { isRunLive, useRunRequestStore, type RunRequestOutcome } from "@/lib/optimize/run-request";
import { getRosterCaptureGate } from "@/lib/optimize/roster-capture-app";
import { assistantActions } from "@/lib/ai/assistant/store";
import { assertTurnAuthority, SUPERSEDED } from "./turn-authority";

/** What the model reads about the run on the Optimise screen. Compact on purpose. */
export interface OptimizeRunSummary {
  status: OptimizeRunView["lifecycle"];
  /** The screen's own heading for a settled run, e.g. "This roster can't be built". */
  heading: string | null;
  outcome: OptimizeRunView["outcome"];
  score: number | null;
  solverStatus: string | null;
  terminationReason: string | null;
  error: { code: string | null; message: string } | null;
  queuePosition: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  downloaded: boolean;
  rosterSaved: boolean;
  guidance: string;
}

const REQUEST_REFUSAL: Record<Exclude<RunRequestOutcome, "started">, string> = {
  "not-ready": "The requested run did not start: dates, staff or shifts are still missing.",
  "backend-offline": "The requested run did not start: the optimiser is not reachable right now.",
  busy: "The requested run did not start: another start was already in progress.",
  blocked:
    "The requested run did not start: the Optimise screen stopped it before sending. It " +
    "shows why there (for example the time limit, or editing taken by another tab).",
  expired:
    "The requested run did not start: it waited too long for the Optimise screen to be " +
    "ready, so it was dropped. The user can press Optimize there, or ask again.",
};

function guidanceFor(
  view: OptimizeRunView,
  rosterSaved: boolean,
  lastRequest: RunRequestOutcome | null,
): string {
  if (view.lifecycle === "idle") {
    if (lastRequest !== null && lastRequest !== "started") {
      return `${REQUEST_REFUSAL[lastRequest]} Tell the user, and help them fix it.`;
    }
    return (
      "No run is showing on the Optimise screen. A run lives only while that screen is " +
      "open; leaving it stops the run. If the user wants a roster, use request_optimize_run."
    );
  }
  if (isRunLive(view.lifecycle)) {
    return (
      "The run is still going. Tell the user to stay on the Optimise screen, where they can " +
      "cancel it or ask it to finish now. Do not describe a result yet; check again later."
    );
  }
  if (view.lifecycle === "completed") {
    switch (view.outcome) {
      case "optimal":
      case "feasible":
        return (
          "A roster was produced. Its XLSX file downloads in the browser, as for any run; if " +
          "it did not, the user can press Download again on the Optimise screen. " +
          (rosterSaved
            ? "It is also saved in the app: the user can open it with Open & adjust roster."
            : "No copy was saved to open in the app; the downloaded file is the result.")
        );
      case "infeasible":
        return (
          "The rules as written cannot all be met, so no roster exists. The solver does not " +
          "say which rule is responsible: never name a cause. You may use " +
          "test_feasibility_candidates to test candidate changes on copies."
        );
      case "inconclusive":
        return (
          "The optimiser found no roster within its time limit and proved nothing either " +
          "way. Suggest a longer time limit on the Optimise screen, or softening hard rules, " +
          "then another run."
        );
    }
  }
  return (
    "The run ended without a roster. Explain the error in plain words; the user can run " +
    "again when ready."
  );
}

/** Project the screen's run view into what the model may read. Pure. */
export function summarizeOptimizeRun(
  view: OptimizeRunView,
  rosterSaved: boolean,
  lastRequest: RunRequestOutcome | null,
): OptimizeRunSummary {
  return {
    status: view.lifecycle,
    heading: terminalHeading(view),
    outcome: view.outcome,
    score: view.result?.score ?? null,
    solverStatus: view.result?.solverStatus ?? null,
    terminationReason: view.result?.terminationReason ?? null,
    error: view.error ? { code: view.error.code, message: view.error.message } : null,
    queuePosition: view.queuePosition,
    startedAt: view.startedAt,
    finishedAt: view.finishedAt,
    downloaded: view.download.status === "downloaded",
    rosterSaved,
    guidance: guidanceFor(view, rosterSaved, lastRequest),
  };
}

export function useOptimizeTools(agentId: string, turnEpoch: number): void {
  useParameterlessModelVisibleTool(
    {
      name: "request_optimize_run",
      agentId,
      description:
        "Offer to run the optimiser on the schedule as it is now. This does NOT start " +
        "anything: it shows the user a card, and the run starts only if they press Run -- " +
        "exactly as if they had pressed Optimize on the Optimise screen. Use it when the " +
        "user wants a roster. A run can take minutes, and leaving the Optimise screen stops it.",
      handler: async ({ token, signal }) => {
        if (isRunLive(useHotStore.getState().runView.lifecycle)) {
          return (
            "A run is already going on the Optimise screen. Do not offer another; use " +
            "get_optimize_result to follow it."
          );
        }
        const readiness = deriveOptimizeReadiness(pickScenario(useScenarioStore.getState()));
        if (!readiness.ready) {
          const missing = readiness.issues.map((issue) => issue.linkLabel).join(", ");
          return (
            `The optimiser cannot run yet. Missing: ${missing}. Help the user set these up ` +
            "first, preparing changes where you can."
          );
        }
        const ownership = await readAuthoritativeScenarioOwnership();
        const late = assertTurnAuthority(token, signal);
        if (late) return late;
        // Narrowing only; the guard above already refuses a null token.
        if (token === null) return SUPERSEDED;
        if (ownership === null || !ownership.isOwner) {
          return (
            "This schedule is being edited in another tab, so a run cannot start here. Tell " +
            "the user they can take over editing in this tab."
          );
        }
        assistantActions.showRunRequest(token.turnEpoch);
        return (
          "The user now sees a card asking whether to run the optimiser. Nothing has started, " +
          "and only the user can start it by pressing Run. Do not say a run has started. Tell " +
          "them it uses the Optimise screen's settings, downloads an XLSX when it finishes, and " +
          "stops if they leave that screen. Once they have pressed Run, use get_optimize_result " +
          "to see how it is going."
        );
      },
    },
    [agentId, turnEpoch],
  );

  useParameterlessModelVisibleTool(
    {
      name: "get_optimize_result",
      agentId,
      description:
        "Read how the latest optimiser run on the Optimise screen is going or how it ended: " +
        "its status, the solver verdict (optimal, feasible, infeasible or inconclusive), any " +
        "error, and whether a roster was saved. It reports only what that screen shows and " +
        "never starts or changes a run.",
      handler: async () => {
        const view = useHotStore.getState().runView;
        const rosterSaved =
          view.jobId !== null && getRosterCaptureGate().getState(view.jobId).status === "committed";
        return summarizeOptimizeRun(view, rosterSaved, useRunRequestStore.getState().last);
      },
    },
    [agentId, turnEpoch],
  );
}
