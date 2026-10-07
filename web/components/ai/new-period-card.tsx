"use client";

// The host card behind `prepare_new_period_from_schedule` (plq5 P3).
//
// Create is host state the model cannot press. It runs the authority's new-period
// Apply, which re-derives the schedule from the past one and refuses if that changed
// since this card was shown; then the new schedule opens and the conversation continues
// there, without the cards made for the old one. A card from a stopped turn shows no
// Create control.

import { useState } from "react";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { assistantProposalCommands, type NewPeriodOutcome } from "@/lib/store";
import { DockCard } from "./dock-card";

/** Why Create failed, in a ward manager's words. */
export function describeNewPeriodFailure(
  reason: Extract<NewPeriodOutcome, { ok: false }>["reason"],
  sourceName: string,
): string {
  switch (reason) {
    case "changed":
      return `“${sourceName}” changed since this preview, so nothing was created. Ask again.`;
    case "missing":
      return `“${sourceName}” was deleted, so nothing was created.`;
    default:
      return "The new schedule could not be created. Nothing was changed.";
  }
}

export function NewPeriodCard({ disabled }: { disabled: boolean }) {
  const active = useAssistantStore((state) => state.activeNewPeriod);
  const liveEpoch = useAssistantStore((state) => state.turnEpoch);
  const [creating, setCreating] = useState(false);
  const [failed, setFailed] = useState<{ id: number; message: string } | null>(null);

  if (active === null) return null;
  const stopped = active.turnEpoch !== liveEpoch;
  const { view } = active;
  const failure = failed?.id === active.id ? failed.message : null;

  const onCreate = async () => {
    setCreating(true);
    setFailed(null);
    try {
      const outcome = await assistantProposalCommands.createNewPeriod(active.request);
      if (outcome.ok) {
        assistantActions.setAsideScheduleCards();
      } else {
        setFailed({
          id: active.id,
          message: describeNewPeriodFailure(outcome.reason, view.sourceName),
        });
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <DockCard
      data-testid="assistant-new-period"
      data-status={stopped ? "stopped" : "live"}
      title={`Create “${view.newName}”?`}
      focusRow={0}
      onClose={stopped ? undefined : () => assistantActions.clearNewPeriod()}
      options={
        stopped
          ? []
          : [
              {
                label: creating ? "Creating…" : "Create and open",
                detail: view.outcome,
                primary: true,
                testId: "new-period-create",
                disabled: disabled || creating || failure !== null,
                onPick: () => void onCreate(),
              },
              {
                label: "Not now",
                detail: "Nothing is created.",
                testId: "new-period-dismiss",
                onPick: () => assistantActions.clearNewPeriod(),
              },
            ]
      }
    >
      {stopped ? (
        <p className="px-1 text-meta text-ink2">
          This offer has ended. Ask again if you still want the new schedule.
        </p>
      ) : (
        <div className="flex flex-col gap-1 px-1 text-meta text-ink2">
          <p>{view.copied}</p>
          <p>{view.holidays}</p>
          <p data-testid="new-period-history">{view.history}</p>
          {view.notCarried ? <p>{view.notCarried}</p> : null}
          {view.dropped.length > 0 ? (
            <>
              <p>Changed by the new dates:</p>
              <ul className="list-disc pl-5" data-testid="new-period-dropped">
                {view.dropped.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          ) : null}
          {failure ? (
            <p className="text-errorink" role="status" data-testid="new-period-failed">
              {failure}
            </p>
          ) : null}
        </div>
      )}
    </DockCard>
  );
}
