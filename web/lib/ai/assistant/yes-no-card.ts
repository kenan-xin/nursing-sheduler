"use client";

// The app's own Yes/No card under a reply that asks a yes/no question in plain text
// (09x8, user decision 2026-09-27). The model is told to use `offer_choices` for these
// and sometimes does not; this catches that deterministically, with no extra model call.
// Pick-one questions with named options stay the model's job: an "or" disqualifies.

import { assistantActions, turnAwaitsUserOnCard, useAssistantStore } from "./store";

// ponytail: first-word test, so "Can you tell me which ward?" still reads as yes/no;
// widen or narrow the list if real transcripts show misfires.
const YES_NO_OPENER =
  /^(?:do|does|did|is|are|was|were|can|could|will|would|shall|should|may|have|has|want|ready|ok|okay|sounds?)\b/i;

/** The yes/no question the text ends on, or null. Markdown emphasis is ignored. */
export function endingYesNoQuestion(text: string): string | null {
  const plain = text.replace(/[*_`]/g, "").trim();
  const last =
    plain
      .split(/(?<=[.!?])\s+|\n+/)
      .at(-1)
      ?.trim() ?? "";
  if (!last.endsWith("?") || /\bor\b/i.test(last) || !YES_NO_OPENER.test(last)) return null;
  return last;
}

/**
 * Show a Yes/No option card for the turn's last reply, unless that turn already showed a
 * card of its own (options, run, roster change, Preview, search). A Preview carried from
 * an earlier message does not count. The answer is sent like any option-card pick.
 */
export function offerYesNoCard(reply: string, turnEpoch: number): void {
  const { activeProposal, activeDiagnostic } = useAssistantStore.getState();
  if (
    turnAwaitsUserOnCard(turnEpoch) ||
    activeProposal?.shownInEpoch === turnEpoch ||
    activeDiagnostic?.turnEpoch === turnEpoch
  )
    return;
  const question = endingYesNoQuestion(reply);
  if (question === null) return;
  assistantActions.showChoices(
    {
      question,
      options: [
        { label: "Yes", detail: "" },
        { label: "No", detail: "" },
      ],
      multiple: false,
    },
    turnEpoch,
  );
}
