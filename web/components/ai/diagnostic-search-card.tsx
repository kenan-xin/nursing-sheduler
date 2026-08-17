"use client";

// T10 — the host-rendered diagnostic search card.
//
// A SIBLING OF THE TRANSCRIPT, not an entry in it — same reason as the Preview card:
// what was tested, what it proves, and the control that cancels it are HOST state,
// and a message the model wrote could claim any of them. The card reads the search
// snapshot the orchestrator publishes on every durable write, so it follows a running
// search without polling.
//
// THE WORDING IS THE PRODUCT. Each candidate line says what its run PROVES, not what
// it suggests: a solvable copy proves only that copy, an untested idea stays a
// suggestion, and when the solver gave no causal explanation the card says exactly
// that rather than implying one. Those strings live in `diagnostic-explanations` so
// they are testable independently of this component.
//
// CANCEL DIAGNOSTIC IS TRUTHFUL ABOUT CAPACITY. A running solve is never pre-empted,
// so the honest thing to show while a diagnostic occupies the worker is that an
// official Optimize run still has a reserved slot and can be started — and that
// cancelling the diagnostic is what frees the worker sooner.

import { useCallback, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Surface } from "@/components/ui/surface";
import { useAssistantStore } from "@/lib/ai/assistant/store";
import {
  CAUSE_UNAVAILABLE,
  candidateEvidenceLabel,
  explainCandidateOutcome,
  explainSearchSummary,
  isSearchActive,
} from "@/lib/ai/diagnostic";
import { cancelOwnedDiagnosticsNow } from "@/lib/ai/diagnostic/diagnostic-canceller";
import { postCancelOptimizeJob } from "@/lib/query/optimize";

/**
 * The diagnostic card. Renders nothing at all when no search has been published.
 *
 * A search stamped with a superseded turn epoch still renders — it is real history
 * the user watched happen — but it renders as STOPPED, with no live controls, which
 * is the same authority rule the Preview card follows.
 */
export function DiagnosticSearchCard() {
  const active = useAssistantStore((state) => state.activeDiagnostic);
  const liveEpoch = useAssistantStore((state) => state.turnEpoch);
  const [cancelling, setCancelling] = useState(false);

  const onCancelDiagnostic = useCallback(async () => {
    setCancelling(true);
    try {
      const controller = new AbortController();
      await cancelOwnedDiagnosticsNow(
        {
          cancelJob: (jobId, signal) => postCancelOptimizeJob(jobId, signal).then(() => undefined),
        },
        controller.signal,
      );
    } finally {
      setCancelling(false);
    }
  }, []);

  if (active === null) return null;

  const { search } = active;
  const superseded = active.turnEpoch !== liveEpoch;
  const running = isSearchActive(search) && !superseded;

  return (
    <Surface
      level="surface"
      geometry="card"
      className="m-3 flex max-h-96 shrink-0 flex-col gap-3 overflow-y-auto p-4"
      data-testid="assistant-diagnostic"
      data-search-id={search.searchId}
      data-status={superseded ? "stopped" : search.status}
      data-stop-reason={search.stopReason ?? ""}
      aria-label="Feasibility testing"
    >
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="font-heading text-cardhead font-semibold tracking-[-0.015em]">
          Testing changes on copies
        </h3>
        {running ? (
          <Badge variant="neutral" data-testid="diagnostic-running">
            Running
          </Badge>
        ) : (
          <Badge variant="outline" data-testid="diagnostic-settled">
            {superseded ? "Stopped" : "Finished"}
          </Badge>
        )}
      </header>

      {/* Never a cause. The solver ships no deterministic infeasibility diagnosis,
          so this baseline is stated up front rather than left to be inferred. */}
      <p className="text-meta text-ink2" data-testid="diagnostic-cause-note">
        {CAUSE_UNAVAILABLE}
      </p>

      <ol className="flex flex-col gap-2" data-testid="diagnostic-candidates">
        {search.candidates.map((candidate) => (
          <li
            key={candidate.candidateId}
            className="flex flex-col gap-1"
            data-testid="diagnostic-candidate"
            data-candidate-outcome={candidate.outcome?.outcome ?? "pending"}
          >
            <Badge variant="outline" casing="normal">
              {candidateEvidenceLabel(candidate.outcome)}
            </Badge>
            {candidate.rationale ? (
              <p className="text-meta text-ink3">
                <span className="font-semibold">Suggested because: </span>
                {candidate.rationale}
              </p>
            ) : null}
            <p className="text-meta text-ink2">
              {explainCandidateOutcome(candidate, candidate.index)}
            </p>
          </li>
        ))}
      </ol>

      {!running ? (
        <p className="text-meta text-ink2" data-testid="diagnostic-summary">
          {superseded
            ? "This testing was stopped, so anything still running was asked to stop too."
            : explainSearchSummary(search)}
        </p>
      ) : null}

      {running ? (
        <div className="flex flex-col gap-2" data-testid="diagnostic-capacity">
          <p className="text-meta text-ink2">
            Testing uses spare solver capacity. An official Optimise run always keeps a reserved
            slot, so you can start one now — but a test already running is never interrupted
            automatically, so it may wait until this test finishes.
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={cancelling}
            onClick={() => void onCancelDiagnostic()}
            data-testid="diagnostic-cancel"
          >
            Cancel testing
          </Button>
        </div>
      ) : null}
    </Surface>
  );
}
