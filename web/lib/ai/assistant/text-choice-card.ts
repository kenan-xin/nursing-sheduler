"use client";

// The app's own option card under a reply that ends on a choice asked in plain text: a
// yes/no question (09x8) or "... A or B?" / "... A, B or C?" (7xw); user decisions
// 2026-09-27. The model is told to use `offer_choices` and sometimes does not; this catches
// the clear shapes deterministically, with no extra model call. Anything unclear gets none.

import { assistantActions, turnAwaitsUserOnCard, useAssistantStore } from "./store";

// ponytail: first-word test, so "Can you tell me which ward?" still reads as yes/no;
// widen or narrow the list if real transcripts show misfires.
const YES_NO_OPENER =
  /^(?:do|does|did|is|are|was|were|can|could|will|would|shall|should|may|have|has|want|ready|ok|okay|sounds?)\b/i;
/** A first word that makes a phrase a clause, a filler or a non-answer, not an option. */
const NOT_AN_OPTION =
  /^(?:do|does|did|is|are|was|were|can|could|will|would|shall|should|may|might|must|have|has|want|i|you|we|it|they|he|she|there|which|what|who|how|when|where|why|if|not|no|nothing|none|so|also|and|but|else|otherwise|something|anything|someone|anyone|other|ok|okay|sure|great|thanks|right|alright|yes|perfect|got)$/i;
const DETERMINER =
  /^(?:the|a|an|every|each|all|this|that|these|those|my|your|our|their|its|some|any)$/i;
const PREPOSITION = /^(?:to|on|in|at|for|by|with|from|before|after|per|until|during)$/i;

export interface TextChoice {
  /** The last sentence, shown as the card's question. */
  question: string;
  options: string[];
}

/** The choice the text ends on, or null when it is not a clear one. Markdown is ignored. */
export function endingTextChoice(text: string): TextChoice | null {
  const plain = text.replace(/[*_`]/g, "").trim();
  const question =
    plain
      .split(/(?<=[.!?])\s+|\n+/)
      .at(-1)
      ?.trim() ?? "";
  if (!question.endsWith("?")) return null;
  if (!/\bor\b/i.test(question))
    return YES_NO_OPENER.test(question) ? { question, options: ["Yes", "No"] } : null;
  const options = namedOptions(question.slice(0, -1));
  return options && { question, options };
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);

function isOption(ws: string[]): boolean {
  return ws.length >= 1 && ws.length <= 5 && !NOT_AN_OPTION.test(ws[0]);
}

/** "Tan Wei" stays; "the Staff screen" becomes "Staff screen"; "nights" becomes "Nights". */
function label(ws: string[]): string {
  const s = (ws.length > 1 && /^(?:the|a|an)$/i.test(ws[0]) ? ws.slice(1) : ws).join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The 2 to 3 options of "STEM A or B" / "STEM A, B or C" (a question body, no "?"), or null.
 * One "or" only, never "either"/"whether", and each option a short phrase. The stem can end
 * on ": " or " - ", or be a "Which ...," clause; otherwise the first option is found by the
 * shape of the one after it (same article or preposition, a number, a name, or as many words).
 * ponytail: word shapes, not grammar; a mid-phrase split ("the month" out of "every night in
 * the month") can still slip through. Tighten here if real transcripts show misfires.
 */
function namedOptions(body: string): string[] | null {
  if (/\b(?:either|whether)\b|\/or\b|\bor\//i.test(body)) return null;
  const halves = body.split(/\s+or\s+/i);
  if (halves.length !== 2 || /,/.test(halves[1])) return null;
  const last = words(halves[1]);
  if (!isOption(last)) return null;

  // "Which do you want: days or nights" / "Which would you prefer, days or nights"
  const listed =
    body.match(/^(.+?)(?::\s+|\s+[-–—]\s+)(.+)$/) ??
    body.match(/^((?:which|what)\b[^,]*),\s*(.+)$/i);
  if (listed) {
    const items = listed[2]
      .split(/,\s*|\s+or\s+/i)
      .filter(Boolean)
      .map(words);
    if (items.length > 3 || !items.every(isOption)) return null;
    return distinct(items.map(label));
  }

  const segments = halves[0].split(/,\s*/);
  if (segments.at(-1) === "") segments.pop();
  const later = [last];
  if (segments.length >= 2 && isOption(words(segments.at(-1)!)))
    later.unshift(words(segments.pop()!));
  const ws = words(segments.at(-1) ?? "");
  const start = firstOptionStart(ws, later[0]);
  if (start < 0) return null;
  // No stem before the first option while more text precedes it: a longer list or a filler.
  if (start === 0 && segments.length > 1) return null;
  const first = ws.slice(start);
  if (!isOption(first)) return null;
  return distinct([first, ...later].map(label));
}

/** Where the first option starts in `ws`, matched to the shape of the option after it. */
function firstOptionStart(ws: string[], next: string[]): number {
  const head = next[0];
  if (DETERMINER.test(head) || PREPOSITION.test(head))
    return ws.map((w) => w.toLowerCase()).lastIndexOf(head.toLowerCase());
  if (/^\d/.test(head)) return ws.findLastIndex((w) => /^\d/.test(w));
  if (/^[A-Z]/.test(head)) {
    let i = ws.length;
    while (i > 0 && /^[A-Z0-9]/.test(ws[i - 1])) i--;
    return i < ws.length ? i : -1;
  }
  // A plain word: as many words as the next option (or one fewer), not starting on a
  // determiner or a preposition and not cut out of a noun phrase ("a nurse from ...").
  const fits = (i: number) =>
    i >= 0 &&
    i < ws.length &&
    !DETERMINER.test(ws[i]) &&
    !PREPOSITION.test(ws[i]) &&
    !(i > 0 && DETERMINER.test(ws[i - 1]));
  const i = ws.length - next.length;
  return fits(i) ? i : fits(i + 1) ? i + 1 : -1;
}

function distinct(labels: string[]): string[] | null {
  return new Set(labels.map((l) => l.toLowerCase())).size === labels.length ? labels : null;
}

/**
 * Show an option card for the turn's last reply, unless that turn already showed a card of
 * its own (options, run, roster change, Preview, search). A Preview carried from an earlier
 * message does not count. The pick is sent like any option-card pick.
 */
export function offerTextChoiceCard(reply: string, turnEpoch: number): void {
  const { activeProposal, activeDiagnostic } = useAssistantStore.getState();
  if (
    turnAwaitsUserOnCard(turnEpoch) ||
    activeProposal?.shownInEpoch === turnEpoch ||
    activeDiagnostic?.turnEpoch === turnEpoch
  )
    return;
  const choice = endingTextChoice(reply);
  if (choice === null) return;
  assistantActions.showChoices(
    {
      question: choice.question,
      options: choice.options.map((label) => ({ label, detail: "" })),
      multiple: false,
    },
    turnEpoch,
  );
}
