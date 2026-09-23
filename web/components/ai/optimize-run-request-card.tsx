"use client";

// The host card behind `request_optimize_run`.
//
// A SIBLING OF THE TRANSCRIPT, like the Preview card: the Run control is host state
// and the model cannot press it. Run takes the user to the Optimise screen (if they
// are not there), then hands the request to that screen, which starts it through its
// own Optimize path (`lib/optimize/run-request.ts`). A card from a turn that was since
// stopped renders as stopped, with no Run control, like a stopped Preview.

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Surface } from "@/components/ui/surface";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { CAPABILITY_UNAVAILABLE } from "@/lib/capability/resolve";
import { isRunLive, requestOptimizeRun } from "@/lib/optimize/run-request";
import { useHotStore } from "@/lib/store";
import { useCapabilityNavigation } from "./use-capability-navigation";

export function OptimizeRunRequestCard() {
  const active = useAssistantStore((state) => state.activeRunRequest);
  const liveEpoch = useAssistantStore((state) => state.turnEpoch);
  const runLive = useHotStore((state) => isRunLive(state.runView.lifecycle));
  const navigate = useCapabilityNavigation();
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);

  if (active === null) return null;
  const stopped = active.turnEpoch !== liveEpoch;

  const onRun = async () => {
    setOpening(true);
    setFailed(false);
    try {
      // The user's click is its own authority, so no turn check -- but an open unsaved
      // draft still gets the same confirm a manual jump does. Keeping the draft asks
      // for nothing and leaves the card up.
      const outcome = await navigate("generate-roster");
      if (outcome.status === CAPABILITY_UNAVAILABLE) {
        if (outcome.reason !== "navigation_cancelled") setFailed(true);
        return;
      }
      requestOptimizeRun();
      assistantActions.clearRunRequest();
    } finally {
      setOpening(false);
    }
  };

  return (
    <Surface
      level="surface"
      geometry="card"
      className="m-3 flex shrink-0 flex-col gap-3 p-4"
      data-testid="assistant-run-request"
      data-status={stopped ? "stopped" : "live"}
      aria-label="Run the optimiser"
    >
      <h3 className="font-heading text-cardhead font-semibold tracking-[-0.015em]">
        Run the optimiser?
      </h3>
      {stopped ? (
        <p className="text-meta text-ink2">
          This offer has ended. Ask again if you still want a run.
        </p>
      ) : (
        <>
          <p className="text-meta text-ink2">
            This sends the schedule as it is now to the optimiser, exactly as pressing Optimize on
            the Optimise screen does. It changes nothing in your set-up. It uses that screen&apos;s
            settings (up to 5 minutes by default) and downloads an XLSX file when it finishes. Stay
            on that screen while it runs: leaving it stops the run.
          </p>
          {runLive ? (
            <p className="text-meta text-ink2" data-testid="run-request-live">
              A run is already going. Wait for it to finish, or cancel it on the Optimise screen.
            </p>
          ) : null}
          {failed ? (
            <p className="text-meta text-errorink" role="status" data-testid="run-request-failed">
              The Optimise screen could not be opened. Open it yourself and press Optimize.
            </p>
          ) : null}
          <footer className="flex flex-wrap items-center gap-2 border-t border-line2 pt-3">
            <Button
              data-testid="run-request-run"
              disabled={runLive || opening}
              onClick={() => void onRun()}
            >
              {opening ? "Opening…" : "Run optimiser"}
            </Button>
            <Button
              variant="ghost"
              data-testid="run-request-dismiss"
              onClick={() => assistantActions.clearRunRequest()}
            >
              Not now
            </Button>
          </footer>
        </>
      )}
    </Surface>
  );
}
