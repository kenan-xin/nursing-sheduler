"use client";

// After a run the user started from the assistant's run card makes a roster, open it.
//
// HOST ACTION, NOT A MODEL TURN, like the Apply navigation notice: the user's Run click
// asked for this run, and the host moves them to its roster through the same guarded
// navigation, so an open unsaved draft still gets the shell's confirm and keeping it
// leaves the user where they are. Only that card's run, and only once its roster is
// saved: an infeasible, failed or cancelled run, or one abandoned by leaving the
// Optimise screen, keeps today's behaviour. `get_optimize_result` reads the outcome.

import { useEffect } from "react";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { CAPABILITY_UNAVAILABLE } from "@/lib/capability/resolve";
import { getRosterCaptureGate } from "@/lib/optimize/roster-capture-app";
import { isRosterGenerated } from "@/lib/optimize/roster-generated";
import { isRunLive, useRunRequestStore } from "@/lib/optimize/run-request";
import { useHotStore } from "@/lib/store";
import { useCapabilityNavigation } from "./use-capability-navigation";

export function useOpenRosterAfterRun(): void {
  const navigate = useCapabilityNavigation();

  useEffect(() => {
    // False after unmount: an in-flight navigation may not push, and its result is dropped.
    let mounted = true;
    const set = assistantActions.setRunFollowUp;

    const open = async () => {
      set("opening");
      const result = await navigate("roster-viewer", { authorize: () => mounted });
      if (!mounted) return;
      if (result.status !== CAPABILITY_UNAVAILABLE) set("opened");
      else set(result.reason === "navigation_cancelled" ? "stayed" : "failed");
    };

    const check = () => {
      const phase = useAssistantStore.getState().runFollowUp;
      const view = useHotStore.getState().runView;
      if (isRunLive(view.lifecycle)) {
        // A run going live is the card's run only if the card asked for one.
        const next = phase === "requested" || phase === "running" ? "running" : null;
        if (next !== phase) set(next);
        return;
      }
      if (phase === "requested") {
        // What is on screen is an earlier run until this one goes live.
        const { last } = useRunRequestStore.getState();
        if (last !== null && last !== "started") set(null);
        return;
      }
      if (phase !== "running") return;
      if (isRosterGenerated(view)) {
        void open();
        return;
      }
      // A found roster is still being saved; anything else ends without one.
      const saving =
        view.lifecycle === "completed" &&
        (view.outcome === "optimal" || view.outcome === "feasible");
      if (!saving) set(null);
    };

    const unsubscribe = [
      useHotStore.subscribe(check),
      useRunRequestStore.subscribe(check),
      getRosterCaptureGate().subscribe(check),
    ];
    check();
    return () => {
      mounted = false;
      for (const stop of unsubscribe) stop();
      if (useAssistantStore.getState().runFollowUp === "opening") set(null);
    };
  }, [navigate]);
}
