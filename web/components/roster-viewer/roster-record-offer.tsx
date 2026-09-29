"use client";

// The one-click "Also record as leave / day off" offer (kyh3). Shown after the
// user sets roster cells to LV or OFF; nothing reaches Requests until the click.
// The write is ONE `setReqData` command — the same store command the Requests
// cell editor uses — so validation, undo and the Requests change highlight apply,
// and a batch is one undo step.

import { useId, useMemo } from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { scenarioCommands, useScenarioStore } from "@/lib/store";
import type { RosterContext } from "@/lib/roster";
import {
  recordCandidates,
  resolveRecordCandidates,
  type RecordCandidate,
  type RecordScenario,
  type RecordableEdit,
} from "./record-as-request";

export interface RosterRecordOfferProps {
  context: RosterContext;
  /** The session's LV/OFF edits still showing on the roster. */
  edits: readonly RecordableEdit[];
  /** Recorded or dismissed: the caller drops these edits from the offer. */
  onDone: () => void;
}

const pickScenario = (s: RecordScenario): RecordScenario => ({
  staff: s.staff,
  rangeStart: s.rangeStart,
  rangeEnd: s.rangeEnd,
  reqData: s.reqData,
});

function actionLabel(kind: RecordCandidate["kind"]): string {
  return kind === "leave" ? "Also record as leave" : "Also record as day off";
}

export function RosterRecordOffer({ context, edits, onDone }: RosterRecordOfferProps) {
  const messageId = useId();
  const scenario = useScenarioStore(useShallow(pickScenario));
  const candidates = useMemo(
    () => resolveRecordCandidates(edits, context, scenario),
    [edits, context, scenario],
  );
  if (candidates.length === 0) return null;
  const pending = candidates.filter((c) => !c.recorded);

  const record = async () => {
    const outcome = await scenarioCommands.setReqData((s) => recordCandidates(s.reqData, pending));
    if (!outcome.ok) {
      toast.error("Could not record in Requests. Try again.");
      return;
    }
    toast.success(
      pending.length === 1
        ? `Recorded in Requests: ${pending[0].label}.`
        : `Recorded ${pending.length} edits in Requests.`,
    );
    onDone();
  };

  let message: string;
  let action: string | null = null;
  if (pending.length === 1) {
    const only = pending[0];
    message = `${only.label} is ${only.kind === "leave" ? "leave" : "a day off"} on this roster only.`;
    action = actionLabel(only.kind);
  } else if (pending.length > 1) {
    message = `${pending.length} leave or day-off edits are on this roster only.`;
    action = `Record ${pending.length} edits`;
  } else {
    const last = candidates[candidates.length - 1];
    message =
      candidates.length === 1
        ? `${last.label} already has ${last.kind === "leave" ? "leave" : "a day off"} in Requests.`
        : "These edits are already in Requests.";
  }

  return (
    <div
      data-testid="roster-record-offer"
      role="status"
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border border-line bg-surface px-3 py-2"
    >
      <span
        id={messageId}
        className="min-w-0 flex-1 text-meta text-ink2"
        data-testid="roster-record-message"
      >
        {message}
      </span>
      {action !== null ? (
        <Button
          size="sm"
          aria-describedby={messageId}
          onClick={() => void record()}
          data-testid="roster-record-action"
        >
          {action}
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" onClick={onDone} data-testid="roster-record-dismiss">
        {action !== null ? "Not now" : "OK"}
      </Button>
    </div>
  );
}
