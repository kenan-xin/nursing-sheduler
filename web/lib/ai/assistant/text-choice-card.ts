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
/** A word that makes a phrase a clause, a filler or a non-answer, not an option. */
const NOT_AN_OPTION =
  /^(?:do|does|did|is|are|was|were|can|could|will|would|shall|should|may|might|must|have|has|want|i|you|we|it|they|he|she|there|which|what|who|how|when|where|why|if|not|no|nothing|none|so|also|and|but|else|otherwise|something|anything|someone|anyone|other|ok|okay|sure|great|thanks|right|alright|yes|perfect|got)$/i;
/** Shapes where the options are not clearly delimited: never a card. */
const UNCLEAR =
  /[&"“”]|(?:^|\s)['‘]|['’](?=[\s?]|$)|\b(?:either|whether|neither|rather than)\b|\/or\b|\bor\/|\b(?:Dr|Mr|Mrs|Ms|St)\.(?=\s)/i;
/** A yes/no opener: with one-word options the question is likely yes/no ("Is that OK for Chloe or Dana?"). */
const YES_NO_SHAPED = /^(?:is|are|does|do|has|have|can|could|will|would|should)\b/i;
/** One-token option kinds; a mid-sentence choice needs every option to be one of the same. */
const TOKEN_KINDS = [
  /^(?!I$)[A-Z]{1,3}\d?$/, // shift code: AM, PM, N, N2
  /^\d+(?:[:.]\d+)?$/, // number or ratio: 3, 7.5, 1:4
  /^\d{4}-\d{2}-\d{2}$|^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$/, // date: 2026-11-05, 5/11
  /^(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day$/, // weekday, before names so never mixed
  /^(?:January|February|March|April|May|June|July|August|September|October|November|December)$/,
  /^[A-Z][a-z]+$/, // one capitalised word: Ben, Chloe
];
/** A lower-case word: an option only when the whole sentence is the options (Nights or weekends?). */
const LOWER_WORD = /^[a-z]+(?:-[a-z]+)*$/;

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
      .split(/(?<!\b(?:Dr|Mr|Mrs|Ms|St)\.)(?<=[.!?]["'”’]?)\s+|\n+/)
      .at(-1)
      ?.trim() ?? "";
  if (!question.endsWith("?")) return null;
  if (!/\bor\b/i.test(question))
    return YES_NO_OPENER.test(question) ? { question, options: ["Yes", "No"] } : null;
  const options = namedOptions(question);
  if (!options || (YES_NO_SHAPED.test(question) && options.every((o) => !o.includes(" "))))
    return null;
  return { question, options };
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
const kindOf = (token: string) => TOKEN_KINDS.findIndex((k) => k.test(token));

/**
 * The 2 to 3 options of an explicitly delimited choice, or null. Only three shapes:
 * (a) a lead-in ending in ":" or " - ", then "A or B?" / "A, B or C?" (same word counts);
 * (b) the whole sentence is one-word options ("Nights or weekends?");
 * (c) one-token options of the same kind (AM or PM, 1:4 or 1:5, Ben or Chloe) right before
 *     the "?", with no tail. Anything else, including a wrong-looking split, gets no card:
 *     a wrong card is worse than none (user, 2026-09-27).
 */
function namedOptions(question: string): string[] | null {
  if (UNCLEAR.test(question)) return null;
  const body = question.slice(0, -1).trim();
  if (body.split(/\s+or\s+/i).length !== 2) return null;
  const listed = body.match(/^(.+?)(?::\s+|\s+[-\u2013\u2014]\s+)(.+)$/);
  const items = (listed ? listed[2] : body)
    .split(/,\s*|\s+or\s+/i)
    .filter(Boolean)
    .map(words);
  if (listed) {
    const n = items[0].length;
    if (n > 4 || !items.every((ws) => ws.length === n && !NOT_AN_OPTION.test(ws[0]))) return null;
    return finish(items.map(label));
  }
  if (items.every((ws) => ws.length === 1)) {
    const tokens = items.map(([t]) => t);
    const first = tokens[0].charAt(0).toLowerCase() + tokens[0].slice(1);
    const sameKind = (ts: string[]) =>
      ts.every((t) => LOWER_WORD.test(t)) ||
      ts.every((t) => kindOf(t) >= 0 && kindOf(t) === kindOf(ts[0]));
    if (tokens.some((t) => NOT_AN_OPTION.test(t))) return null;
    if (sameKind(tokens) || sameKind([first, ...tokens.slice(1)]))
      return finish(tokens.map((t) => t.charAt(0).toUpperCase() + t.slice(1)));
  }
  return inlineTokens(body);
}

/** Shape (c): "... A or B" / "... A, B or C" where each option is one token of one kind. */
function inlineTokens(body: string): string[] | null {
  const [head, tail] = body.split(/\s+or\s+/i);
  const last = words(tail);
  const kind = kindOf(last[0] ?? "");
  if (last.length !== 1 || kind < 0) return null;
  const segments = head.split(/,\s*/).filter(Boolean);
  const inSegment = words(segments.at(-1) ?? "");
  const options = [inSegment.at(-1) ?? "", last[0]];
  let before = inSegment.at(-2);
  if (inSegment.length === 1 && segments.length >= 2) {
    const prev = words(segments.at(-2)!);
    if (kindOf(prev.at(-1)!) === kind) {
      if (prev.length === 1 && segments.length >= 3) return null; // four or more options
      options.unshift(prev.at(-1)!);
      before = prev.at(-2);
    }
  }
  // "... on Monday, or Dana": a comma before a two-option "or" leaves the first unclear.
  if (options.length === 2 && head.includes(",")) return null;
  // A same-kind token before the first option means a longer name or code: not delimited.
  if (before !== undefined && kindOf(before) === kind) return null;
  if (!options.every((t) => kindOf(t) === kind && !NOT_AN_OPTION.test(t))) return null;
  return finish(options);
}

/** "the Staff screen" becomes "Staff screen"; "nights" becomes "Nights". */
function label(ws: string[]): string {
  const s = (ws.length > 1 && /^(?:the|a|an)$/i.test(ws[0]) ? ws.slice(1) : ws).join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function finish(labels: string[]): string[] | null {
  const distinct = new Set(labels.map((l) => l.toLowerCase())).size === labels.length;
  return distinct && labels.length >= 2 && labels.length <= 3 ? labels : null;
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
