"use client";

// THE ONE-CLICK RETRY FOR A TURN THE USER NEVER GOT AN ANSWER FROM (bead 2by.8).
//
// The panel already SAID the right thing -- every failed or interrupted settlement
// ends "Send again to retry." -- and offered nothing to press. This is the control
// that sentence promises.
//
// It is deliberately NOT a second send path. It replays the failed turn's own question
// through the conversation's ordinary `send`, carrying the failed turn's id so the
// send gate replaces that turn as it prepares. Readiness, ownership, the writer lease,
// the turn epoch, the generation fences and the final launch authorization are all the
// gate's, unchanged, so a retry cannot reach the provider by any route a typed message
// could not.
//
// THE QUESTION COMES FROM DURABLE HISTORY, and from the failed turn's OWN user message
// rather than "the last user message on screen". A turn that failed before its question
// was written has nothing to send again, and a control that resent an earlier question
// instead would be asking the user's previous question on their behalf.

import { useCallback, useEffect, useState } from "react";

import { readLatestTurn, readThreadMessages } from "@/lib/ai/assistant/history-repo";
import { isRetryableSettlement } from "@/lib/ai/assistant/lifecycle";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import type { AssistantSendOptions } from "./use-assistant-session";

/** The settled turn a retry would replace, and the question it left behind. */
export interface RetryTarget {
  turnId: string;
  text: string;
}

export interface AssistantRetry {
  /** Whether the control may be pressed right now. */
  canRetry: boolean;
  /**
   * Whether the durable lookup for the last settled turn is still running.
   *
   * Exposed so a host can keep the control closed until it has an answer. `canRetry` is
   * already false while it is true; the difference is that "no retry available" and
   * "not known yet" are different facts, and only one of them is stable.
   */
  checking: boolean;
  retry(): void;
}

export interface AssistantRetryInput {
  threadId: string;
  send(text: string, options?: AssistantSendOptions): Promise<boolean>;
  /** Whether a turn is already live, so a retry would only be refused as busy. */
  busy: boolean;
}

export function useAssistantRetry(input: AssistantRetryInput): AssistantRetry {
  const settlement = useAssistantStore((state) => state.lastSettlement);
  const kind = settlement?.settlement ?? null;
  const [target, setTarget] = useState<RetryTarget | null>(null);
  const [checking, setChecking] = useState(false);
  // Set the instant the control is pressed, so it closes SYNCHRONOUSLY -- before `busy`
  // has had a chance to catch up -- and one click can only ever start one send.
  const [sent, setSent] = useState(false);

  const { threadId, send } = input;

  useEffect(() => {
    setSent(false);
    setTarget(null);
    if (kind === null || !isRetryableSettlement(kind)) {
      // Not a turn the user may send again, so there is nothing to look up: this
      // settles at "no" rather than being left undecided.
      setChecking(false);
      return;
    }

    let cancelled = false;
    setChecking(true);
    void readLatestTurn(threadId)
      .then(async (turn) => {
        // ONLY A SETTLED TURN CAN BE REPLACED. An unsettled one is live work, and the
        // notice on screen belongs to a turn that has already ended.
        if (!turn || turn.terminalReason === null) return null;
        const records = await readThreadMessages(threadId);
        const question = records.find(
          (record) => record.turnId === turn.turnId && record.role === "user",
        );
        return question ? { turnId: turn.turnId, text: question.content } : null;
      })
      // A read that failed is not a failed turn: it means only that no retry can be
      // offered from what is known.
      .catch(() => null)
      .then((found) => {
        if (cancelled) return;
        setTarget(found);
        setChecking(false);
      });

    return () => {
      cancelled = true;
    };
  }, [threadId, kind]);

  const retry = useCallback(() => {
    if (target === null) return;
    setSent(true);
    // A retry IS a user send, so it answers an open option card exactly as a typed
    // message does. What it must NOT do is go through an adapter of its own: `send` is
    // the conversation's own send, so the text, the options and every gate the gate
    // owns arrive at the same call site as the composer's.
    assistantActions.clearChoices();
    void send(target.text, { replaceTurnId: target.turnId }).then((accepted) => {
      // Refused before preparing, so nothing left the panel and the control is owed
      // back to the user.
      if (!accepted) setSent(false);
    });
  }, [send, target]);

  return {
    // `checking` is part of this so the control never appears and then changes its mind
    // a microtask later.
    canRetry: target !== null && !checking && !input.busy && !sent,
    checking,
    retry,
  };
}
